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
import { readJsonFile } from '../web/secrets-file.js';
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
  readonly models = new SpeechModels();

  constructor(
    private readonly configFile: string,
    private readonly secrets: SecretsFile,
    private readonly ledger: UsageLedger,
    private readonly log: Logger,
    /** Installer-owned paths (models, state); filled into every config. */
    private readonly paths?: InstallPaths,
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
    const raw = { secretsFile: this.secrets.path, ...readJsonFile<Record<string, unknown>>(this.configFile) };
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
   *  Calls are serialized. */
  restart(): Promise<StackState> {
    const run = async (): Promise<StackState> => {
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
      const problems = this.problems();
      if (problems.length) {
        this._state = 'setup';
        this._error = undefined;
        this.log.info('setup mode', { missing: problems.length });
        return this._state;
      }
      this._state = 'starting';
      this._error = undefined;
      try {
        const config = this.config()!;
        this.stack = await startVoiceStack(config, this.secrets.read(), this.log, this.ledger, this.models, this.paths?.stateDir);
        this.startedAt = Date.now();
        this._state = 'running';
      } catch (e) {
        this._state = 'failed';
        this._error = redact((e as Error).message).slice(0, 300);
        this.log.error('voice stack failed to start', { error: this._error });
      }
      return this._state;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async stop(): Promise<void> {
    await this.chain;
    const s = this.stack;
    this.stack = undefined;
    this._state = 'stopped';
    if (s) await s.stop();
  }
}
