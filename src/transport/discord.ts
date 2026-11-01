// Discord implementation of VoiceTransport (@discordjs/voice 0.19.2 + DAVE).
//
// Receive is not officially documented by Discord, so everything about it
// stays inside this file. Each user gets their own Opus subscription and
// decoder, keyed by Discord user ID; audio from different users is never
// mixed. Audio is kept in memory only and handed to listeners as it arrives.

import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioReceiveStream,
  type VoiceConnection,
} from '@discordjs/voice';
import { Events, type Client, type VoiceState } from 'discord.js';
import prism from 'prism-media';
import { bufferToInt16, downmixStereo } from '../audio/pcm.js';
import type {
  Logger,
  PlaybackHandle,
  UserId,
  VoiceTransport,
  VoiceTransportEvents,
} from '../core/interfaces.js';

const SAMPLE_RATE = 48_000;
/** Quick rejoin attempts on a lost connection, before it reports `failed`. */
const MAX_REJOINS = 5;
/** Past that it keeps trying at this pace: an outage must not end voice until a restart. */
const SLOW_REJOIN_MS = 5 * 60_000;
/** Left Ready and not back after this long: the library's own reconnect has no
 *  time limit, and one lost packet leaves it in Signalling or Connecting for good. */
const STUCK_MS = 30_000;

/** Opus bitrate for everything the bot plays (music and speech). */
const OPUS_BITRATE = 128_000;

export interface DiscordTransportOptions {
  client: Client;
  logger: Logger;
  /** Silence (ms) that ends one user's utterance. */
  silenceMs: number;
  /** Verbose DAVE/voice debug lines (dev only). */
  debug?: boolean;
}

/** Voice debug lines echo raw gateway payloads, including the session's
 *  media key and the voice server token. Strip those before logging. */
export function redactVoiceDebug(line: string): string {
  return line
    .replace(/(\\?"secret_key\\?"\s*:\s*)\[[^\]]*\]/g, '$1"[redacted]"')
    .replace(/(\\?"(?:token|session_id)\\?"\s*:\s*\\?")[^"\\]+/g, '$1[redacted]');
}

interface UserStream {
  opus: AudioReceiveStream;
  decoder: prism.opus.Decoder;
}

export class DiscordVoiceTransport extends EventEmitter implements VoiceTransport {
  private readonly client: Client;
  private readonly log: Logger;
  private readonly silenceMs: number;
  private readonly debug: boolean;
  private connection: VoiceConnection | undefined;
  private readonly player: AudioPlayer;
  private readonly streams = new Map<UserId, UserStream>();
  private target: { guildId: string; channelId: string } | undefined;
  private rejoins = 0;
  /** The `gen` a recovery is running for: one at a time, but a stale one can't block a newer. */
  private recovering: number | undefined;
  /** Bumped by connect/disconnect/kick: an older reconnect attempt stops. */
  private gen = 0;
  private closing = false;
  /** She left the channel herself and isn't back: the gateway's report of that isn't a kick. */
  private ownLeave = false;
  private readonly onVoiceState = (oldS: VoiceState, newS: VoiceState) => this.voiceStateChanged(oldS, newS);

  constructor(opts: DiscordTransportOptions) {
    super();
    this.client = opts.client;
    this.log = opts.logger;
    this.silenceMs = opts.silenceMs;
    this.debug = opts.debug ?? false;
    // A short hiccup must not end playback: the default gives up after 5
    // missing frames (100 ms) and music would restart with a gap.
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 50 } });
    this.player.on('error', (e) => this.log.warn('playback error', { error: e.message }));
  }

  override on<E extends keyof VoiceTransportEvents>(event: E, listener: VoiceTransportEvents[E]): this {
    return super.on(event, listener);
  }
  override off<E extends keyof VoiceTransportEvents>(event: E, listener: VoiceTransportEvents[E]): this {
    return super.off(event, listener);
  }

  isReady(): boolean {
    return this.connection?.state.status === VoiceConnectionStatus.Ready;
  }

  async connect(guildId: string, channelId: string): Promise<void> {
    this.gen++;
    this.target = { guildId, channelId };
    this.closing = false;
    this.rejoins = 0;
    this.client.on(Events.VoiceStateUpdate, this.onVoiceState);
    await this.join();
  }

  /** connect() tries once, so /join can say it failed. This keeps at it in the
   *  background (the join at startup) until it works or disconnect() is called. */
  retry(): void {
    if (this.closing || !this.target || this.connection) return;
    void this.recover().catch((e: Error) => this.log.warn('voice recovery failed', { error: e.message }));
  }

  async disconnect(): Promise<void> {
    this.gen++;
    this.closing = true;
    this.client.off(Events.VoiceStateUpdate, this.onVoiceState);
    this.player.stop(true);
    this.dropAllStreams();
    if (this.connection) this.leave(this.connection);
  }

  play(source: string | NodeJS.ReadableStream, opts?: { volume?: number }): PlaybackHandle {
    const stream = (typeof source === 'string' ? createReadStream(source) : source) as Readable;
    let stopped = false;
    const done = (async (): Promise<'finished' | 'stopped' | 'error'> => {
      try {
        const { stream: probed, type } = await demuxProbe(stream);
        const resource = createAudioResource(probed, { inputType: type, inlineVolume: true });
        resource.volume?.setVolume(opts?.volume ?? 0.7);
        this.player.play(resource);
        await entersState(this.player, AudioPlayerStatus.Playing, 5_000);
        await new Promise<void>((resolve) => {
          const onIdle = () => {
            this.player.off(AudioPlayerStatus.Idle, onIdle);
            resolve();
          };
          this.player.on(AudioPlayerStatus.Idle, onIdle);
        });
        return stopped ? 'stopped' : 'finished';
      } catch (e) {
        this.log.warn('playback failed', { error: (e as Error).message });
        return 'error';
      }
    })();
    return {
      done,
      stop: () => {
        stopped = true;
        this.player.stop(true);
      },
    };
  }

  playPcm(stream: NodeJS.ReadableStream, opts?: { volume?: number }): PlaybackHandle {
    let stopped = false;
    const volume = opts?.volume ?? 0.7;
    // Volume 1 (the mixer sets its own levels) skips the extra volume stage.
    const resource = createAudioResource(stream as Readable, { inputType: StreamType.Raw, inlineVolume: volume !== 1 });
    resource.volume?.setVolume(volume);
    // Music needs more than the encoder's default; FEC hides lost packets.
    resource.encoder?.setBitrate(OPUS_BITRATE);
    resource.encoder?.setFEC(true);
    resource.encoder?.setPLP(5);
    this.player.play(resource);
    const done = new Promise<'finished' | 'stopped' | 'error'>((resolve) => {
      const onIdle = () => {
        this.player.off(AudioPlayerStatus.Idle, onIdle);
        this.player.off('error', onError);
        resolve(stopped ? 'stopped' : 'finished');
      };
      const onError = () => {
        this.player.off(AudioPlayerStatus.Idle, onIdle);
        this.player.off('error', onError);
        resolve('error');
      };
      this.player.on(AudioPlayerStatus.Idle, onIdle);
      this.player.on('error', onError);
    });
    return {
      done,
      stop: () => {
        stopped = true;
        this.player.stop(true);
      },
    };
  }

  // --- connection lifecycle ---------------------------------------------

  private async join(): Promise<void> {
    const t = this.target;
    if (!t) throw new Error('connect() was not called');
    const guild = await this.client.guilds.fetch(t.guildId);
    const conn = joinVoiceChannel({
      guildId: t.guildId,
      channelId: t.channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
      debug: this.debug,
    });
    this.connection = conn;
    if (this.debug) conn.on('debug', (m) => this.log.debug('voice', { m: redactVoiceDebug(m) }));
    conn.on('error', (e) => this.log.warn('voice connection error', { error: e.message }));
    conn.on('stateChange', (oldS, newS) => {
      if (oldS.status !== newS.status) this.log.info('voice state', { from: oldS.status, to: newS.status });
      if (newS.status === VoiceConnectionStatus.Ready) {
        this.rejoins = 0;
        this.ownLeave = false;
        this.emit('ready');
      }
      // Out of Ready with no Disconnected: the library is reconnecting by itself.
      const resuming = oldS.status === VoiceConnectionStatus.Ready && (newS.status === VoiceConnectionStatus.Signalling || newS.status === VoiceConnectionStatus.Connecting);
      if ((resuming || newS.status === VoiceConnectionStatus.Disconnected) && !this.closing && this.connection === conn) {
        void this.recover(conn, resuming).catch((e: Error) => this.log.warn('voice recovery failed', { error: e.message }));
      }
    });
    conn.on('transitioned', (id) => this.log.debug('dave transition', { id }));
    conn.subscribe(this.player);
    conn.receiver.speaking.on('start', (userId) => this.userStarted(userId));
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    } catch (e) {
      // Don't leave a half-open connection behind: the next join would reuse
      // it and stack a second set of listeners on it.
      this.leave(conn);
      throw e;
    }
    this.log.info('voice ready', { guildId: t.guildId, channelId: t.channelId });
    this.emitMembers();
  }

  /** Leave the channel on purpose. Skipping the leave (`destroy(false)`) isn't an
   *  option: she'd rejoin a channel she's still in, and Discord seems to ignore that. */
  private leave(conn: VoiceConnection): void {
    if (conn.state.status !== VoiceConnectionStatus.Destroyed) this.ownLeave = true;
    safeDestroy(conn);
    if (this.connection === conn) this.connection = undefined;
  }

  /** Discord's documented recovery: a disconnect followed by Signalling or
   *  Connecting within 5 s is a channel move or a resumable drop; otherwise
   *  rejoin from scratch, with backoff. `resuming`: the library has already
   *  started. No `conn`: there's nothing to wait for, go straight to rejoining. */
  private async recover(conn?: VoiceConnection, resuming = false): Promise<void> {
    const gen = this.gen;
    if (this.recovering === gen) return; // one recovery at a time
    this.recovering = gen;
    try {
      await this.recoverOnce(conn, resuming);
    } finally {
      if (this.recovering === gen) this.recovering = undefined;
    }
  }

  private async recoverOnce(conn: VoiceConnection | undefined, resuming: boolean): Promise<void> {
    const gen = this.gen;
    const current = () => !this.closing && gen === this.gen; // not kicked, moved or left meanwhile
    if (conn) {
      this.emit('disconnected', 'voice connection dropped');
      try {
        if (!resuming) {
          await Promise.race([
            entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
            entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        }
        await entersState(conn, VoiceConnectionStatus.Ready, STUCK_MS);
        return; // the library reconnected by itself
      } catch {
        /* fall through to a full rejoin */
      }
      if (!current()) return;
      this.log.warn('voice stuck, rebuilding', { status: conn.state.status });
      this.dropAllStreams();
      this.leave(conn);
    }
    while (current()) {
      if (this.rejoins === MAX_REJOINS) this.emit('failed', `not back after ${MAX_REJOINS} rejoin attempts; still trying`);
      this.rejoins++;
      const delay = this.rejoins > MAX_REJOINS ? SLOW_REJOIN_MS : Math.min(30_000, 1_000 * 2 ** (this.rejoins - 1)) + Math.random() * 500;
      this.log.warn('rejoining voice', { attempt: this.rejoins, delayMs: Math.round(delay) });
      await new Promise<void>((r) => void setTimeout(r, delay).unref());
      if (!current()) return;
      try {
        await this.join();
        return;
      } catch (e) {
        this.log.warn('rejoin failed', { error: (e as Error).message });
      }
    }
  }

  // --- per-user receive ---------------------------------------------------

  private userStarted(userId: UserId): void {
    if (userId === this.client.user?.id || this.streams.has(userId) || !this.connection) return;
    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.silenceMs },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: 2, frameSize: 960 });
    this.streams.set(userId, { opus, decoder });
    this.emit('speechStart', userId);

    decoder.on('data', (pcm: Buffer) => {
      this.emit('audio', userId, {
        samples: downmixStereo(bufferToInt16(pcm)),
        sampleRate: SAMPLE_RATE,
        receivedAt: performance.now(),
      });
    });
    const finish = () => {
      if (this.streams.get(userId)?.opus !== opus) return;
      this.streams.delete(userId);
      decoder.destroy();
      this.emit('speechEnd', userId);
    };
    opus.on('error', (e) => {
      this.log.warn('receive error', { userId, error: e.message });
      finish();
    });
    decoder.on('error', (e) => this.log.warn('opus decode error', { userId, error: e.message }));
    opus.on('end', finish);
    opus.on('close', finish);
    opus.pipe(decoder);
  }

  private dropAllStreams(): void {
    for (const [userId, s] of this.streams) {
      s.opus.destroy();
      s.decoder.destroy();
      this.emit('speechEnd', userId);
    }
    this.streams.clear();
  }

  // --- channel membership ------------------------------------------------

  private voiceStateChanged(oldS: VoiceState, newS: VoiceState): void {
    const me = newS.id === this.client.user?.id;
    // Back in a channel: a leave from here on isn't one of hers.
    if (me && newS.channelId && newS.channelId !== oldS.channelId) this.ownLeave = false;
    const ch = this.target?.channelId;
    if (!ch || (oldS.channelId !== ch && newS.channelId !== ch)) return;
    if (me && newS.channelId !== ch && !this.closing) {
      if (newS.channelId && this.target) {
        // Dragged into another channel: that's where it is now.
        this.log.info('moved to another channel', { channelId: newS.channelId });
        this.target = { ...this.target, channelId: newS.channelId };
        this.dropAllStreams();
        this.emit('moved', this.target.guildId, newS.channelId);
      } else if (!this.ownLeave) {
        // Someone disconnected it (or the channel is gone). Respect that: no
        // fighting back in; /join brings it back.
        this.log.info('disconnected from voice by someone; staying out until /join');
        void this.disconnect().finally(() => this.emit('kicked'));
        return;
      }
    }
    this.emitMembers();
  }

  private emitMembers(): void {
    const t = this.target;
    if (!t) return;
    const channel = this.client.guilds.cache.get(t.guildId)?.channels.cache.get(t.channelId);
    const members = new Set<UserId>();
    if (channel?.isVoiceBased()) {
      for (const id of channel.members.keys()) if (id !== this.client.user?.id) members.add(id);
    }
    this.emit('membersChanged', members);
  }
}

/** Destroy a voice connection unless it already is (destroying twice throws). */
function safeDestroy(conn: VoiceConnection): void {
  if (conn.state.status === VoiceConnectionStatus.Destroyed) return;
  try {
    conn.destroy();
  } catch {
    /* already gone */
  }
}
