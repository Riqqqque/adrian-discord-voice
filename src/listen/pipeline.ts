// Listening pipeline (milestone 3): per user, Discord audio → 16 kHz →
// Silero VAD → speech segments → Parakeet (shared, one at a time) → wake
// check. Each user has their own downsampler and VAD keyed by user ID, so
// audio and state never mix between users. Audio lives only in memory.

import { EventEmitter } from 'node:events';
import { rmsDbfs } from '../audio/pcm.js';
import type { SpeechToText, UserId, VoiceTransport, WakeDetector } from '../core/interfaces.js';
import { ASR_SAMPLE_RATE, Downsampler, type SileroOptions, SileroVad } from '../speech/sherpa.js';
import type { TurnDetector } from '../speech/smart-turn.js';

export interface HeardEvent {
  userId: UserId;
  /** Full transcript (dev logging only; never persisted). */
  text: string;
  woke: boolean;
  /** Text after the wake phrase. */
  command: string;
  /** Woken by the looser check (bare name, or wake phrase mid-sentence). */
  loose?: boolean;
  /** The clip, 16 kHz mono, for a second recognition pass. Never stored. */
  samples?: Float32Array;
  audioSeconds: number;
  levelDbfs: number;
  /** Clip released to recognition → transcript ready, ms. */
  sttLatencyMs: number;
  /** performance.now() when the clip was released: the VAD close, or after any hold. */
  segmentClosedAt: number;
  decodeMs: number;
  /** performance.now() when the VAD closed the clip's last segment. */
  vadClosedAt?: number;
  /** The VAD's own silence wait, or the transport's end of speech. */
  closedBy?: ClosedBy;
  /** VAD close → Smart Turn's answer, ms. Only where it answered in time. */
  turnCheckMs?: number;
  /** Smart Turn's answer → release, ms: what a hold added (0: not held). */
  holdMs?: number;
}

export type ClosedBy = 'vad' | 'flush';
type ClipTiming = Pick<HeardEvent, 'vadClosedAt' | 'closedBy' | 'turnCheckMs' | 'holdMs'>;
type Words = Awaited<ReturnType<SpeechToText['transcribe']>>;

export interface ListeningPipelineEvents {
  heard: (e: HeardEvent) => void;
  /** Continuous speech from a user so far, ms (for barge-in). */
  voiceActivity: (userId: UserId, voicedMs: number) => void;
  error: (userId: UserId, err: Error) => void;
}

/** Speech held because it sounded unfinished (turn option). */
interface HeldSpeech {
  samples: Float32Array;
  timer?: NodeJS.Timeout;
  since: number;
  epoch: number;
  /** The last segment's close; `since` is the first's. */
  closedAt: number;
  closedBy: ClosedBy;
  /** When Smart Turn answered for the last segment. */
  checkedAt?: number;
  /** Recognition of exactly `samples`, once started. A join starts over. */
  words?: Promise<Words>;
}

export interface UserState {
  down: Downsampler;
  vad: SileroVad;
  /** performance.now() when the current run of speech began. */
  voicedSince?: number;
  held?: HeldSpeech;
  epoch: number;
}

/** Waiting for the rest of a sentence (PC rooms): see src/speech/smart-turn.ts. */
export interface TurnOptions {
  detector: TurnDetector;
  /** How much longer to wait after the normal silence when it sounds unfinished, ms. */
  holdMs: number;
  /** Logs each hold, for tuning. */
  onHold?: (userId: UserId, info: { probability: number; seconds: number }) => void;
  /** Asked with the words when it sounds unfinished: false releases it at once,
   *  unless they're talking again by then. `seconds` is the clip's length, for
   *  judging it from when they started talking, as heard is. Unset, everything
   *  that sounds unfinished is held. See endsDangling. */
  shouldHold?: (userId: UserId, text: string, seconds: number) => boolean;
  /** The words of speech that is being held, for starting a second listen early.
   *  `samples` is the array the heard event will carry, unless a join replaces it. */
  onHeldWords?: (userId: UserId, words: { text: string; samples: Float32Array }) => void;
}

/** Segments shorter than this are coughs/clicks; don't spend ASR on them. */
const MIN_SEGMENT_SECONDS = 0.3;
/** Silence after the speech when asking whether the turn is over (what the normal wait has heard). */
const TURN_TAIL = new Float32Array(Math.round(0.8 * ASR_SAMPLE_RATE));
/** Between held speech and what came next, so the recognizer hears a pause. */
const JOIN_GAP = new Float32Array(Math.round(0.25 * ASR_SAMPLE_RATE));
/** Never hold one person's speech longer than this in total, ms. */
const MAX_HOLD_MS = 15_000;
/** Last words that want another after them. This only overrules a check that
 *  already calls the clip unfinished: a word too many costs what every hold
 *  used to, a word too few cuts a sentence in half. When in doubt, it's on here. */
const DANGLING = new Set(
  (
    // what comes before a noun
    'a an the this that these those my your his her our their its some any each every either neither both another several which whose what ' +
    // prepositions
    'about above across after against along among around as at before behind below beneath beside besides between beyond by during except for from in inside into like near of onto outside over past per since than through till to toward towards under until upon via with within without ' +
    // what joins two thoughts
    'and or but nor so because cuz cause although unless while if whether when where who whom why how plus ' +
    // what comes before a verb
    'i we they he she am is are was were be been being do does did have has had can could will would shall should may might must ' +
    "i'm i'd i'll i've you're you'd you'll you've he's she's it's we're we'd we'll we've they're they'd they'll they've that's what's who's where's when's how's why's there's here's let's " +
    "isn't aren't wasn't weren't don't doesn't didn't can't won't wouldn't couldn't shouldn't haven't hasn't hadn't ain't gonna wanna gotta lemme gimme " +
    // orders missing what they're about
    'play put open search set turn tell ask show find get give make add start remind message text send call check look close queue launch run say write read change switch want need let ' +
    // thinking out loud
    'um uh er erm ah hmm hm mm actually basically maybe ' +
    // Spanish: she answers in it, and it often needs no accents
    'el la los las un una unos unas lo al del de en con sin por para y e o u ni que pero porque si como cuando donde mi mis tu tus su sus este esta ese esa es son pon ponme abre busca dile dime quiero'
  ).split(' '),
);
/** The same for two last words: "turn it on" is finished, "turn on" isn't. */
const DANGLING_PAIRS = new Set(['put on', 'throw on', 'turn on', 'turn off', 'switch on', 'switch off', 'look up', 'and then', 'turn it', 'put it', 'can you', 'could you', 'would you', 'will you', 'do you', 'did you', 'you please']);
/** Orders that take two things: "tell Sam" still has to say what. */
const TAKES_TWO = new Set('tell ask message text remind show give send'.split(' '));

/** "Hey Adrian, play" stopped mid-sentence; "Hey Adrian" and "just play Ella
 *  Langley" didn't. Text that isn't plain ASCII can't be judged, so it counts as
 *  stopped, like everything Smart Turn doubts without this rule. Other languages
 *  in plain letters are the caller's to catch: this only knows English and Spanish. */
export function endsDangling(text: string): boolean {
  if (/\P{ASCII}/u.test(text)) return true;
  const w = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const last = w.at(-1) ?? '';
  const before = w.at(-2) ?? '';
  return DANGLING.has(last) || DANGLING_PAIRS.has(`${before} ${last}`) || TAKES_TWO.has(before);
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export class ListeningPipeline extends EventEmitter {
  protected readonly users = new Map<UserId, UserState>();

  constructor(
    private readonly transport: VoiceTransport,
    private readonly stt: SpeechToText,
    private readonly wake: WakeDetector,
    private readonly vadOptions: SileroOptions,
    private readonly turn?: TurnOptions,
  ) {
    super();
    transport.on('audio', (id, chunk) => {
      const u = this.user(id);
      const segments = u.vad.accept(u.down.push(chunk.samples));
      if (u.vad.isSpeaking()) {
        u.voicedSince ??= chunk.receivedAt;
        this.emit('voiceActivity', id, Math.round(chunk.receivedAt - u.voicedSince));
      } else {
        delete u.voicedSince;
      }
      for (const s of segments) this.handleSegment(id, s, 'vad');
    });
    // Discord stopped sending for this user: close any open segment.
    transport.on('speechEnd', (id) => {
      const u = this.users.get(id);
      if (!u) return;
      delete u.voicedSince;
      for (const s of u.vad.flush()) this.handleSegment(id, s, 'flush');
    });
    transport.on('membersChanged', (members) => {
      for (const id of this.users.keys()) if (!members.has(id)) this.users.delete(id);
    });
  }

  override on<E extends keyof ListeningPipelineEvents>(e: E, l: ListeningPipelineEvents[E]): this {
    return super.on(e, l);
  }

  protected user(id: UserId): UserState {
    let u = this.users.get(id);
    if (!u) {
      u = { down: new Downsampler(), vad: new SileroVad(this.vadOptions), epoch: 0 };
      this.users.set(id, u);
    }
    return u;
  }

  private handleSegment(userId: UserId, samples: Float32Array, closedBy: ClosedBy): void {
    const closedAt = performance.now();
    const short = samples.length / ASR_SAMPLE_RATE < MIN_SEGMENT_SECONDS;
    if (!this.turn) {
      if (!short) this.transcribe(userId, samples, { vadClosedAt: closedAt, closedBy });
      return;
    }
    const u = this.users.get(userId);
    if (!u) return;
    const held = u.held;
    if (short) {
      // a cough while we wait: keep waiting, but don't let the wait stall
      if (held && !held.timer) this.arm(userId, u);
      return;
    }
    if (held?.timer) clearTimeout(held.timer);
    const all = held ? concat(held.samples, JOIN_GAP, samples) : samples;
    const epoch = ++u.epoch;
    u.held = {
      samples: all,
      since: held?.since ?? performance.now(),
      epoch,
      closedAt,
      closedBy,
      // Recognize beside the check: the words are ready by the time a hold
      // ends. A join changes the audio, so what was started for it is dropped.
      ...(held ? {} : { words: this.decode(all) }),
    };
    void this.turn.detector
      .complete(concat(all.length > 8 * ASR_SAMPLE_RATE ? all.subarray(all.length - 8 * ASR_SAMPLE_RATE) : all, TURN_TAIL))
      .catch(() => 1) // if the model fails, don't make anyone wait
      .then((p) => {
        const h = u.held;
        if (!h || h.epoch !== epoch) return; // more speech came in meanwhile
        h.checkedAt = performance.now();
        if (p > 0.5 || performance.now() - h.since > MAX_HOLD_MS) {
          this.release(userId, u);
        } else {
          this.hold(userId, u, h, p);
        }
      });
  }

  /** It sounds unfinished. The wait starts now, so the words' decode isn't
   *  added on top of it; shouldHold can only end it early. */
  private hold(userId: UserId, u: UserState, h: HeldSpeech, probability: number): void {
    const turn = this.turn;
    if (!turn) return;
    this.arm(userId, u);
    const holding = () => turn.onHold?.(userId, { probability: Number(probability.toFixed(2)), seconds: Number((h.samples.length / ASR_SAMPLE_RATE).toFixed(2)) });
    if (!turn.shouldHold) holding();
    if (!turn.shouldHold && !turn.onHeldWords) return;
    void (h.words ??= this.decode(h.samples))
      .then(
        ({ text }) => {
          if (u.held !== h) return; // joined, or the wait already ran out
          if (turn.shouldHold) {
            if (!turn.shouldHold(userId, text, h.samples.length / ASR_SAMPLE_RATE)) {
              // talking again: that's the rest of it, whatever the words so far say
              if (!u.vad.isSpeaking()) this.release(userId, u);
              return;
            }
            holding();
          }
          if (text) turn.onHeldWords?.(userId, { text, samples: h.samples });
        },
        () => undefined, // the hold stands; release reports it
      )
      .catch((e: Error) => this.emit('error', userId, e));
  }

  /** Release held speech after holdMs, unless they're talking again by then. */
  private arm(userId: UserId, u: UserState): void {
    const h = u.held;
    if (!h || !this.turn) return;
    const check = () => {
      if (u.held !== h) return;
      // talking again: the VAD will close a segment soon and that decides
      if (u.vad.isSpeaking() && performance.now() - h.since < MAX_HOLD_MS) {
        h.timer = setTimeout(check, 300);
        return;
      }
      this.release(userId, u);
    };
    h.timer = setTimeout(check, this.turn.holdMs);
  }

  private release(userId: UserId, u: UserState): void {
    const h = u.held;
    if (!h) return;
    if (h.timer) clearTimeout(h.timer);
    delete u.held;
    const timing: ClipTiming = {
      vadClosedAt: h.closedAt,
      closedBy: h.closedBy,
      ...(h.checkedAt !== undefined ? { turnCheckMs: Math.round(h.checkedAt - h.closedAt), holdMs: Math.round(performance.now() - h.checkedAt) } : {}),
    };
    this.transcribe(userId, h.samples, timing, h.words);
  }

  /** Start recognizing a clip. A join can leave held words unread, so a
   *  failure only counts where they're read. */
  private decode(samples: Float32Array): Promise<Words> {
    const words = this.stt.transcribe(samples, ASR_SAMPLE_RATE);
    void words.catch(() => undefined);
    return words;
  }

  private transcribe(userId: UserId, samples: Float32Array, timing: ClipTiming, words?: Promise<Words>): void {
    const audioSeconds = samples.length / ASR_SAMPLE_RATE;
    const segmentClosedAt = performance.now();
    const pcm = Int16Array.from(samples, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
    const levelDbfs = Number(rmsDbfs(pcm).toFixed(1));
    (words ?? this.decode(samples))
      .then(({ text, decodeMs }) => {
        if (!text) return;
        const m = this.wake.matchLoose?.(text) ?? { ...this.wake.match(text), loose: false };
        this.emit('heard', {
          userId,
          text,
          woke: m.woke,
          command: m.remainder,
          ...(m.loose ? { loose: true } : {}),
          samples,
          audioSeconds: Number(audioSeconds.toFixed(2)),
          levelDbfs,
          sttLatencyMs: Math.round(performance.now() - segmentClosedAt),
          segmentClosedAt,
          decodeMs,
          ...timing,
        } satisfies HeardEvent);
      })
      .catch((e: Error) => this.emit('error', userId, e));
  }
}
