// Owns the voice stack's lifecycle for the service: setup mode until the
// config is complete, then start, restart on settings changes, and report
// state for /api/health. Speech models are loaded once and shared between
// restarts and the wizard's voice preview (the server is memory-tight).

import { redact } from '../core/logger.js';
import { PocConfigSchema, type PocConfig } from '../config.js';
import type { Logger } from '../core/interfaces.js';
import type { UsageLedger } from '../limits/usage-ledger.js';
import { KokoroTts } from '../speech/kokoro.js';
import { ParakeetStt } from '../speech/sherpa.js';
import { readConfigFile } from '../web/secrets-file.js';
import type { SecretsFile } from '../web/secrets-file.js';
import { baseConfig, type InstallPaths } from '../web/settings.js';
import { startVoiceStack, type VoiceStack } from './stack.js';

export type StackState = 'setup' | 'starting' | 'running' | 'failed' | 'stopped';

export class SpeechModels {
  private stt: { key: string; p: Promise<ParakeetStt> } | undefined;
  private tts: { key: string; v: KokoroTts } | undefined;

  sttFor(modelDir: string, threads: number): Promise<ParakeetStt> {
    const key = `${modelDir}|${threads}`;
    if (this.stt?.key !== key) {
      const p = ParakeetStt.load({ modelDir, threads });
      p.catch(() => (this.stt = undefined));
      this.stt = { key, p };
    }
    return this.stt.p;
  }

  ttsFor(modelDir: string, threads: number): KokoroTts {
    const key = `${modelDir}|${threads}`;
    if (this.tts?.key !== key) this.tts = { key, v: new KokoroTts({ modelDir, threads }) };
    return this.tts.v;
  }
}

/** A start that failed for a passing reason is tried again after this long... */
const FIRST_RETRY_MS = 30_000;
/** ...doubling up to this. */
const MAX_RETRY_MS = 5 * 60_000;
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

/** Could this failed start work later with nothing changed? Only what's known to
 *  pass by itself counts: no DNS yet after a power cut, Discord having an outage.
 *  A bad token, a missing model or a broken config stays failed with its reason. */
export function canRecover(e: unknown): boolean {
  for (let c = e, depth = 0; c instanceof Error && depth < 5; c = c.cause, depth++) {
    const { code, status } = c as Error & { code?: unknown; status?: unknown };
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
    if (c.name === 'AbortError' || c.name === 'TimeoutError') return true;
    if (typeof status === 'number' && status >= 500) return true;
    if (/^Unexpected server response: 5\d\d$/.test(c.message)) return true; // the gateway's handshake
  }
  return false;
}

/** Why the current config can't run yet, or undefined if it can. */
export function configProblems(raw: Record<string, unknown>, secrets: Map<string, string>): string[] {
  const out: string[] = [];
  if (!secrets.get('DISCORD_TOKEN')) out.push('The Discord bot token is not set.');
  if (!raw.guildId || !raw.channelId) out.push('No Discord server and voice channel chosen.');
  const brain = raw.brain as { apiKeySecret?: unknown } | undefined;
  if (!brain) out.push('No language model chosen.');
  else if (typeof brain.apiKeySecret === 'string' && brain.apiKeySecret && !secrets.get(brain.apiKeySecret)) {
    out.push(`The language model key (${brain.apiKeySecret}) is not set.`);
  }
  if (!raw.listen || !raw.voice) out.push('Speech models are not configured. Save any setup step, or run `sudo adrian doctor`.');
  const parsed = PocConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const k = String(i.path[0] ?? '');
      if (['guildId', 'channelId', 'brain', 'listen', 'voice'].includes(k) && raw[k] === undefined) continue; // reported above
      out.push(`Config ${i.path.join('.') || '(root)'}: ${i.message}`);
    }
  }
  return out;
}

export class StackManager {
  private stack: VoiceStack | undefined;
  private _state: StackState = 'stopped';
  private _error: string | undefined;
  private startedAt: number | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | undefined;
  private retryMs = FIRST_RETRY_MS;
  readonly models = new SpeechModels();

  constructor(
    private readonly configFile: string,
    private readonly secrets: SecretsFile,
    private readonly ledger: UsageLedger,
    private readonly log: Logger,
    /** Installer-owned paths (models, state); filled into every config. */
    private readonly paths?: InstallPaths,
    private readonly start: typeof startVoiceStack = startVoiceStack,
  ) {}

  get state(): StackState {
    return this._state;
  }
  get error(): string | undefined {
    return this._error;
  }
  get current(): VoiceStack | undefined {
    return this.stack;
  }
  get uptimeS(): number | null {
    return this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null;
  }

  rawConfig(): Record<string, unknown> {
    // Paths are fixed by the installer; fill them in even before the first
    // settings save (and for setups done only with the CLI).
    const raw = { secretsFile: this.secrets.path, ...readConfigFile(this.configFile) };
    return this.paths ? baseConfig(this.paths, raw) : raw;
  }

  /** Parsed config if complete. */
  config(): PocConfig | undefined {
    const p = PocConfigSchema.safeParse(this.rawConfig());
    return p.success ? p.data : undefined;
  }

  problems(): string[] {
    return configProblems(this.rawConfig(), this.secrets.read());
  }

  /** Start (or restart) if the config is complete; otherwise setup mode.
   *  Calls are serialized. systemd can't help with a failed start, because the
   *  process stays up for the admin UI, so one that can recover retries here. */
  restart(): Promise<StackState> {
    const run = async (): Promise<StackState> => {
      clearTimeout(this.retryTimer);
      const wait = this.retryMs;
      this.retryMs = FIRST_RETRY_MS; // only another failure that can recover moves it on
      if (this.stack) {
        const s = this.stack;
        this.stack = undefined;
        this.startedAt = undefined;
        try {
          await s.stop();
        } catch (e) {
          this.log.warn('stop failed', { error: (e as Error).message });
        }
      }
      try {
        const problems = this.problems(); // throws on a config file that can't be read
        if (problems.length) {
          this._state = 'setup';
          this._error = undefined;
          this.log.info('setup mode', { missing: problems.length });
          return this._state;
        }
        this._state = 'starting';
        this._error = undefined;
        const config = this.config()!;
        this.stack = await this.start(config, this.secrets.read(), this.log, this.ledger, this.models, this.paths?.stateDir);
        this.startedAt = Date.now();
        this._state = 'running';
      } catch (e) {
        this._state = 'failed';
        this._error = redact((e as Error).message).slice(0, 300);
        this.log.error('voice stack failed to start', { error: this._error });
        if (canRecover(e)) {
          this.log.warn('trying the voice stack again', { inSeconds: wait / 1000 });
          this.retryMs = Math.min(wait * 2, MAX_RETRY_MS);
          this.retryTimer = setTimeout(() => void this.restart(), wait);
          this.retryTimer.unref();
        }
      }
      return this._state;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async stop(): Promise<void> {
    await this.chain; // a start still running can leave a retry behind
    clearTimeout(this.retryTimer);
    const s = this.stack;
    this.stack = undefined;
    this._state = 'stopped';
    if (s) await s.stop();
  }
}
