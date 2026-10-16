// Milestone 2 proof of concept: join a voice channel under DAVE, receive
// separate per-user audio, play a normalized test clip, survive reconnects.
//
// Usage: node dist/poc/main.js <config.json>
// Audio is never written anywhere; only per-utterance statistics are logged.

import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { loadConfig, readSecrets } from '../config.js';
import type { UserId } from '../core/interfaces.js';
import { createLogger } from '../core/logger.js';
import { ListeningPipeline } from '../listen/pipeline.js';
import { ParakeetStt } from '../speech/sherpa.js';
import { DiscordVoiceTransport } from '../transport/discord.js';
import { TextWakeDetector } from '../wake/text-wake.js';

const log = createLogger(process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info');
const configPath = process.argv[2];
if (!configPath) {
  console.error('usage: node dist/poc/main.js <config.json>');
  process.exit(2);
}
const config = loadConfig(configPath);
const token = process.env.DISCORD_TOKEN ?? readSecrets(config.secretsFile).get('DISCORD_TOKEN');
if (!token) {
  console.error(`DISCORD_TOKEN is not set in ${config.secretsFile}`);
  process.exit(2);
}

// Minimal intents: guilds + voice states. No privileged intents.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const transport = new DiscordVoiceTransport({
  client,
  logger: log,
  silenceMs: config.silenceMs,
  debug: process.env.VOICE_DEBUG === '1',
});

// --- per-user statistics (no audio retained) ------------------------------

interface Utterance {
  startedAt: number;
  firstAudioAt?: number;
  samples: number;
  sumSq: number;
  peakConcurrent: number;
}
const active = new Map<UserId, Utterance>();
const totals = new Map<UserId, { utterances: number; seconds: number }>();
const names = new Map<UserId, string>();

function nameOf(id: UserId): string {
  if (names.has(id)) return names.get(id)!;
  const member = client.guilds.cache.get(config.guildId)?.members.cache.get(id);
  const n = member?.displayName ?? member?.user.username ?? 'unknown';
  names.set(id, n);
  return n;
}

transport.on('speechStart', (id) => {
  active.set(id, { startedAt: performance.now(), samples: 0, sumSq: 0, peakConcurrent: active.size + 1 });
  for (const u of active.values()) u.peakConcurrent = Math.max(u.peakConcurrent, active.size);
});
transport.on('audio', (id, chunk) => {
  const u = active.get(id);
  if (!u) return;
  u.firstAudioAt ??= chunk.receivedAt;
  u.samples += chunk.samples.length;
  for (let i = 0; i < chunk.samples.length; i++) {
    const v = chunk.samples[i]! / 32768;
    u.sumSq += v * v;
  }
});
transport.on('speechEnd', (id) => {
  const u = active.get(id);
  active.delete(id);
  if (!u) return;
  const seconds = u.samples / 48_000;
  const rms = u.samples ? Math.sqrt(u.sumSq / u.samples) : 0;
  const t = totals.get(id) ?? { utterances: 0, seconds: 0 };
  t.utterances++;
  t.seconds += seconds;
  totals.set(id, t);
  log.info('utterance', {
    user: id,
    name: nameOf(id),
    audioSeconds: Number(seconds.toFixed(2)),
    levelDbfs: rms ? Number((20 * Math.log10(rms)).toFixed(1)) : null,
    firstAudioMs: u.firstAudioAt ? Math.round(u.firstAudioAt - u.startedAt) : null,
    overlappedWith: u.peakConcurrent - 1,
  });
});
transport.on('membersChanged', (m) => log.info('members', { count: m.size, users: [...m].map(nameOf) }));
transport.on('disconnected', (r) => log.warn('voice disconnected', { reason: r }));
transport.on('failed', (r) => log.error('voice failed', { reason: r }));

let clipPlays = 0;
function playClip(): void {
  if (!config.testClip) return;
  clipPlays++;
  const h = transport.play(config.testClip, { volume: config.playbackVolume });
  void h.done.then((r) => log.info('test clip', { result: r, plays: clipPlays }));
}
transport.on('ready', () => setTimeout(playClip, 1_000));

// --- listening pipeline (milestone 3) -----------------------------------

if (config.listen) {
  const l = config.listen;
  const t0 = performance.now();
  const stt = await ParakeetStt.load({ modelDir: l.asrModelDir, threads: l.asrThreads });
  log.info('asr loaded', { ms: Math.round(performance.now() - t0), threads: l.asrThreads });
  const pipeline = new ListeningPipeline(transport, stt, new TextWakeDetector({ name: l.wakeName }), {
    model: l.vadModel,
    threshold: l.vadThreshold,
    minSilence: l.minSilence,
    minSpeech: l.minSpeech,
    maxSpeech: l.maxSpeech,
  });
  pipeline.on('heard', (e) => {
    const base = {
      user: e.userId,
      name: nameOf(e.userId),
      woke: e.woke,
      audioSeconds: e.audioSeconds,
      levelDbfs: e.levelDbfs,
      sttLatencyMs: e.sttLatencyMs,
      decodeMs: e.decodeMs,
    };
    log.info(e.woke ? 'wake' : 'heard', l.logTranscripts ? { ...base, text: e.text, command: e.command } : base);
  });
  pipeline.on('error', (id, err) => log.warn('listen error', { user: id, error: err.message }));
}

// --- slash commands for manual testing ----------------------------------

client.once(Events.ClientReady, async (c) => {
  log.info('logged in', { bot: c.user.tag });
  const guild = await c.guilds.fetch(config.guildId);
  await guild.commands.set([
    {
      name: 'adrian-poc',
      description: 'A.D.R.I.A.N. voice proof-of-concept controls',
      options: [
        { type: 1, name: 'play', description: 'Play the test clip' },
        { type: 1, name: 'rejoin', description: 'Leave and rejoin the voice channel' },
        { type: 1, name: 'stats', description: 'Per-user receive totals since start' },
      ],
    },
  ]);
  await transport.connect(config.guildId, config.channelId);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'adrian-poc') return;
  const sub = i.options.getSubcommand();
  if (sub === 'play') {
    playClip();
    await i.reply({ content: 'Playing the test clip.', flags: MessageFlags.Ephemeral });
  } else if (sub === 'rejoin') {
    await i.reply({ content: 'Rejoining voice.', flags: MessageFlags.Ephemeral });
    await transport.disconnect();
    await transport.connect(config.guildId, config.channelId);
  } else if (sub === 'stats') {
    const lines = [...totals].map(
      ([id, t]) => `${nameOf(id)}: ${t.utterances} utterances, ${t.seconds.toFixed(1)} s`,
    );
    await i.reply({ content: lines.join('\n') || 'No audio received yet.', flags: MessageFlags.Ephemeral });
  }
});

const shutdown = async (sig: string) => {
  log.info('shutting down', { signal: sig });
  await transport.disconnect();
  await client.destroy();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await client.login(token);
