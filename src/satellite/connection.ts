// One connected PC satellite, seen by the voice stack as a voice transport:
// its microphone is one "user" (the owner), and what the stack plays is sent
// back as audio. See docs/satellite.md for the protocol.

import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import type { PlaybackHandle, UserId, VoiceTransport, VoiceTransportEvents } from '../core/interfaces.js';
import type { Device } from './devices.js';

export type SatelliteMode = 'idle' | 'listening' | 'thinking' | 'speaking';

/** Audio both ways: 48 kHz mono s16le. */
export const SAT_RATE = 48_000;

export interface SatelliteEvents extends VoiceTransportEvents {
  /** Push-to-talk pressed: the next thing said is for her. */
  ptt: () => void;
  /** A typed question from the window. */
  text: (text: string) => void;
  /** The stop button. */
  stop: () => void;
  closed: () => void;
}

interface Pending {
  resolve: (r: { ok: boolean; result: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SatelliteConnection extends EventEmitter implements VoiceTransport {
  private open = true;
  private nextAction = 1;
  private readonly pending = new Map<string, Pending>();
  /** Last time the PC sent anything (for picking the active PC). */
  lastSeen = Date.now();

  constructor(
    private readonly ws: WebSocket,
    readonly device: Device,
  ) {
    super();
    ws.on('message', (data, isBinary) => {
      this.lastSeen = Date.now();
      if (isBinary) this.onAudio(data as Buffer);
      else this.onJson(String(data));
    });
    ws.on('close', () => this.close());
    ws.on('error', () => this.close());
  }

  get owner(): UserId {
    return this.device.owner;
  }

  /** Called once the stack has set up its listeners. */
  start(): void {
    this.emit('ready');
    this.emit('membersChanged', new Set([this.owner]));
  }

  private onAudio(buf: Buffer): void {
    if (buf.length < 2) return;
    // Copy into an aligned buffer: Int16Array needs an even byte offset.
    const bytes = buf.length & ~1;
    const samples = new Int16Array(bytes / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2);
    this.emit('audio', this.owner, { samples, sampleRate: SAT_RATE, receivedAt: performance.now() });
  }

  private onJson(text: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m.type) {
      case 'speech_start':
        this.emit('speechStart', this.owner);
        break;
      case 'speech_end':
        this.emit('speechEnd', this.owner);
        break;
      case 'ptt':
        if (m.down !== false) this.emit('ptt');
        break;
      case 'text':
        if (typeof m.text === 'string' && m.text.trim()) this.emit('text', m.text.trim().slice(0, 2000));
        break;
      case 'stop':
        this.emit('stop');
        break;
      case 'action_result': {
        const p = typeof m.id === 'string' ? this.pending.get(m.id) : undefined;
        if (!p) break;
        clearTimeout(p.timer);
        this.pending.delete(m.id as string);
        p.resolve({ ok: m.ok === true, result: typeof m.result === 'string' ? m.result.slice(0, 4000) : '' });
        break;
      }
      case 'ping':
        this.send({ type: 'pong' });
        break;
    }
  }

  send(msg: Record<string, unknown>): void {
    if (this.open && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  mode(mode: SatelliteMode): void {
    this.send({ type: 'mode', mode });
  }

  /** Her voice is audible on the PC (not just music), and how much longer she
   *  takes words without her name there (ms, 0 = not listening). */
  state(s: { speaking?: boolean; listenMs?: number }): void {
    this.send({ type: 'state', ...s });
  }

  transcript(who: 'you' | 'her', text: string, final = true): void {
    this.send({ type: 'transcript', who, text, final });
  }

  /** Ask the PC to do something; resolves with its answer or a timeout. */
  action(name: string, args: Record<string, unknown>, timeoutMs = 15_000): Promise<{ ok: boolean; result: string }> {
    if (!this.open) return Promise.resolve({ ok: false, result: 'The PC disconnected.' });
    const id = String(this.nextAction++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, result: "The PC didn't answer in time." });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send({ type: 'action', id, name, args });
    });
  }

  // --- VoiceTransport ----------------------------------------------------

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.ws.close(1000, 'bye');
    this.close();
  }

  isReady(): boolean {
    return this.open;
  }

  play(): PlaybackHandle {
    throw new Error('satellites only take PCM');
  }

  /** 48 kHz stereo s16le in (the mixer's output), 48 kHz mono out to the PC. */
  playPcm(stream: NodeJS.ReadableStream): PlaybackHandle {
    let carry: Buffer = Buffer.alloc(0);
    let finish!: (r: 'finished' | 'stopped' | 'error') => void;
    const done = new Promise<'finished' | 'stopped' | 'error'>((r) => (finish = r));
    let stopped = false;
    const onData = (chunk: Buffer) => {
      if (stopped || !this.open) return;
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const frames = Math.floor(buf.length / 4);
      carry = buf.subarray(frames * 4);
      if (!frames) return;
      const out = Buffer.allocUnsafe(frames * 2);
      for (let i = 0; i < frames; i++) out.writeInt16LE((buf.readInt16LE(i * 4) + buf.readInt16LE(i * 4 + 2)) >> 1, i * 2);
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(out, { binary: true });
    };
    const end = (r: 'finished' | 'stopped' | 'error') => {
      stream.off('data', onData);
      finish(r);
    };
    stream.on('data', onData);
    stream.once('end', () => end('finished'));
    stream.once('error', () => end('error'));
    return {
      done,
      stop: () => {
        if (stopped) return;
        stopped = true;
        // The PC holds a little audio ahead; tell it to drop that too.
        this.send({ type: 'audio_stop' });
        end('stopped');
      },
    };
  }

  override on<E extends keyof SatelliteEvents>(event: E, listener: SatelliteEvents[E]): this {
    return super.on(event, listener);
  }

  override off<E extends keyof SatelliteEvents>(event: E, listener: SatelliteEvents[E]): this {
    return super.off(event, listener);
  }

  private close(): void {
    if (!this.open) return;
    this.open = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, result: 'The PC disconnected.' });
    }
    this.pending.clear();
    this.emit('closed');
  }
}
