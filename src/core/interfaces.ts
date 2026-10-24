// Provider interfaces from the build brief (section 4). Every provider is
// swappable behind these; the rest of the module depends only on them.
//
// Audio convention between layers: mono, signed 16-bit PCM. Discord delivers
// 48 kHz stereo Opus; the transport decodes and downmixes, and callers
// resample for the speech models (16 kHz).

export type UserId = string;

export interface PcmChunk {
  /** Mono s16 samples. */
  samples: Int16Array;
  sampleRate: number;
  /** Monotonic receive time of the chunk, ms (performance.now()). */
  receivedAt: number;
}

export interface VoiceTransportEvents {
  /** Connection reached the "ready" state (also after a reconnect). */
  ready: () => void;
  /** Connection lost; the transport is trying to recover. */
  disconnected: (reason: string) => void;
  /** Recovery failed; the transport gave up. */
  failed: (reason: string) => void;
  /** A user started an utterance (Discord speaking start). */
  speechStart: (userId: UserId) => void;
  /** Decoded audio for one user. Never mixed with other users. */
  audio: (userId: UserId, chunk: PcmChunk) => void;
  /** A user's utterance ended (silence timeout). */
  speechEnd: (userId: UserId) => void;
  /** Members in the voice channel changed. */
  membersChanged: (members: ReadonlySet<UserId>) => void;
  /** Someone moved the bot to another voice channel in the same server. */
  moved: (guildId: string, channelId: string) => void;
  /** Someone disconnected the bot from voice (or the channel went away): it stays out until asked back. */
  kicked: () => void;
}

export interface PlaybackHandle {
  /** Resolves when playback finished or was stopped. */
  readonly done: Promise<'finished' | 'stopped' | 'error'>;
  /** Stop immediately. */
  stop(): void;
}

export interface VoiceTransport {
  connect(guildId: string, channelId: string): Promise<void>;
  disconnect(): Promise<void>;
  isReady(): boolean;
  /** Play an Ogg/Opus or WAV file, or a stream of the same. */
  play(source: string | NodeJS.ReadableStream, opts?: { volume?: number }): PlaybackHandle;
  /** Play raw 48 kHz stereo s16le PCM as it is written to the stream. */
  playPcm(stream: NodeJS.ReadableStream, opts?: { volume?: number }): PlaybackHandle;
  on<E extends keyof VoiceTransportEvents>(event: E, listener: VoiceTransportEvents[E]): this;
  off<E extends keyof VoiceTransportEvents>(event: E, listener: VoiceTransportEvents[E]): this;
}

// --- Later milestones. Declared now so the shape is agreed; no
// implementations yet. ---

export interface VoiceActivityDetector {
  /** Feed 16 kHz mono float audio; returns completed speech segments. */
  accept(samples: Float32Array): Float32Array[];
  /** End of input (e.g. the user stopped transmitting): return any
   *  segment still open. */
  flush(): Float32Array[];
  reset(): void;
}

export interface WakeDetector {
  /** Strips the wake phrase if the transcript starts with it. */
  match(transcript: string): { woke: boolean; remainder: string };
  /** Looser: also "Adrian, ..." and "... hey Adrian, ..." mid-sentence. The
   *  model then decides whether it was really meant for the bot. */
  matchLoose?(transcript: string): { woke: boolean; remainder: string; loose: boolean };
}

export interface SpeechToText {
  /** Mono float samples. Resolves with the text and the decode time. */
  transcribe(
    samples: Float32Array,
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; decodeMs: number }>;
}

export interface TextToSpeech {
  /** Synthesize one sentence; returns mono float audio, already
   *  loudness-normalized (about −16 LUFS, peaks under −1 dBTP). */
  synthesize(
    text: string,
    opts: { voice: string; speed: number },
    signal?: AbortSignal,
  ): Promise<{ samples: Float32Array; sampleRate: number; synthMs: number }>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments, as the model produced them. */
  arguments: string;
  /** Provider data that must be echoed back with the call (Gemini 3's
   *  `extra_content.google.thought_signature`). Opaque. */
  extra?: unknown;
}

export type ChatMessage =
  /** cache: Claude caches everything up to and including this system block. */
  | { role: 'system' | 'user'; content: string; cache?: boolean }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; cache?: boolean }
  | { role: 'tool'; content: string; toolCallId: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'toolCalls'; calls: ToolCall[] }
  | { type: 'usage'; inputTokens: number; cachedTokens: number; outputTokens: number; cacheWriteTokens?: number };

export interface LlmProvider {
  readonly model: string;
  stream(
    messages: ChatMessage[],
    /** toolChoice none: tools are listed (keeps the cached prefix) but may not be called. */
    opts: { tools?: ToolSpec[]; toolChoice?: 'none'; signal?: AbortSignal; maxTokens?: number },
  ): AsyncIterable<LlmEvent>;
}

export interface MemoryStore {
  /** Recent turns for this user only; never another user's. */
  history(userId: UserId): { role: 'user' | 'assistant'; content: string }[];
  append(userId: UserId, turn: { role: 'user' | 'assistant'; content: string }): void;
  clear(userId: UserId): void;
}

/** Who asked, and from which call. */
export interface ToolContext {
  userId: UserId;
  speaker: string;
  guildId?: string;
  channelId?: string;
}

export interface Tool {
  spec: ToolSpec;
  /** Returns text the model treats as untrusted data. Tools change only the
   *  bot's own state (timers, notes, games, music), except message_member,
   *  which sends a rate-limited, attributed Discord message. */
  run(args: Record<string, unknown>, signal: AbortSignal, ctx: ToolContext): Promise<string>;
  /** Longest the tool may take (default 5 s). Music lookups need more. */
  timeoutMs?: number;
  /** Takes long enough that a short "one sec" first is worth it. */
  slow?: boolean;
  /** When it succeeds, the answer is done: no words after it (a sound effect). */
  endsTurn?: boolean;
  /** A line to say for this result instead of asking the model again
   *  ("Spotify's open."), or undefined to let the model answer. Used when
   *  every tool in the round gives one; saves a model call. */
  speak?(args: Record<string, unknown>, result: string): string | undefined;
}

export interface SecretsStore {
  get(name: string): string | undefined;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
