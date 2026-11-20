// The production prompt for real-model benches: every tool the live bot offers
// (2026-11-19 `brain ready` line, 45 tools) in stack.ts's order, and its cached
// rule lines in their order. Keep it in step with stack.ts.
//
// Tools whose answer is local and harmless run for real (time, dice, notes,
// alarms and timers on a stub clock); everything that would reach the network,
// Discord or a PC returns a canned answer from `answers[name](args)` (or
// "Nothing found."). `record(name, args)` sees every call.
import { genderLines } from '../dist/app/identity.js';
import { matureContext } from '../dist/brain/mature.js';
import { tavilySearchTool, timeTool } from '../dist/brain/tools.js';
import { ALARM_RULE, alarmTools } from '../dist/features/alarm-tools.js';
import { AlarmClock } from '../dist/features/alarms.js';
import { Briefing } from '../dist/features/briefing.js';
import { discordTools, RelayLimiter } from '../dist/features/discordinfo.js';
import { GAME_NIGHT_RULE, gameNightTool } from '../dist/features/gamenight.js';
import { PartyGames } from '../dist/features/games.js';
import { gameServerTool } from '../dist/features/gameservers.js';
import { HANDOFF_RULE, handoffTools, tellCallTool } from '../dist/features/handoff.js';
import { Headlines } from '../dist/features/headlines.js';
import { HeadsUp } from '../dist/features/headsup.js';
import { mediaTools } from '../dist/features/media.js';
import * as music from '../dist/features/music.js';
import { UserNotes } from '../dist/features/notes.js';
import { Quizzes } from '../dist/features/quiz.js';
import { Recap } from '../dist/features/recap.js';
import { Reminders } from '../dist/features/reminders.js';
import { SOUND_RULE, soundTool } from '../dist/features/sounds.js';
import { Steam, steamTools } from '../dist/features/steam.js';
import { MusicTaste } from '../dist/features/taste.js';
import { Weather } from '../dist/features/weather.js';
import { PC_RULE, pcTools } from '../dist/satellite/tools.js';
import { LANGS } from '../dist/speech/language.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
/** Run for real: no network, no sound, nothing outside this process. */
const LOCAL = new Set(['get_time', 'set_reminder', 'set_alarm', 'set_timer', 'edit_alarm', 'list_timers', 'cancel_timer', 'alarm_control', 'alarm_options', 'remember', 'forget', 'roll_dice', 'flip_coin', 'game', 'music_taste']);

export function prodKit(c, { record = () => {}, answers = {}, pc = true, player } = {}) {
  const tz = c.timezone;
  const stubPlayer =
    player ??
    new Proxy({}, {
      get: (_t, k) => {
        if (k === 'nowPlaying' || k === 'lent') return undefined;
        if (k === 'upNext' || k === 'recent') return [];
        if (k === 'paused' || k === 'youtubePaused') return false;
        if (k === 'autoplay') return true;
        return async () => ({ ok: true, started: { title: 'Nights', artist: 'Frank Ocean', source: 'youtube', ref: '' }, added: 3 });
      },
    });
  const taste = new MusicTaste(undefined);
  const reminders = new Reminders(undefined, tz, async () => {});
  const clock = new AlarmClock(undefined, tz, { placeFor: () => 'discord', ring: () => ({ stop() {}, alive: () => true }), dm: async () => true });
  const notes = new UserNotes(undefined);
  const nobody = { candidates: () => [] };
  const fakePc = { action: async (name) => ({ ok: true, result: answers[name]?.({}) ?? 'Done.' }) };
  const headlines = new Headlines(c.news?.feeds ?? [], async () => new Response(''));
  const weather = new Weather(c.weather ?? {}, tz, async () => new Response('{}'));
  const briefing = new Briefing({ weather, headlines, reminders: () => [], calendarFor: () => false, timezone: tz, headlineCount: 3 });
  const headsUp = new HeadsUp(undefined, c.headsUp, { sources: {}, timezone: tz, isOwner: () => false, audible: () => false, quiet: () => true, say: async () => false, log: quiet });
  const recap = new Recap(undefined, { enabled: false, timezone: tz, day: 0, hour: 18 }, { sources: {}, post: async () => {}, nameOf: () => 'x', named: () => false, isOwner: () => false, log: quiet });
  const quizzes = new Quizzes({ settings: c.music?.quiz ?? {}, log: quiet, sources: () => ({ recent: () => [], log: quiet }) });
  const unused = { url: 'http://unused.invalid', token: 'unused', apiKey: 'unused' };
  const real = [
    timeTool(tz),
    tavilySearchTool('unused'),
    ...reminders.tools().filter((t) => t.spec.name === 'set_reminder'),
    ...alarmTools({ clock, reminders, english: () => true, reach: () => 'call', preview: async () => true, saveClip: async () => 'Not in this bench.', musicOk: true }),
    ...notes.tools(),
    ...new PartyGames().tools(),
    ...music.musicTools(stubPlayer, taste),
    ...taste.tools(),
    quizzes.tool(() => undefined),
    soundTool({ find: async () => undefined, play: async () => {} }),
    ...(pc ? pcTools({ pcFor: () => fakePc, findVideo: async () => 'jfKfPfyJRdk' }) : []),
    ...discordTools({ client: {}, allowedGuilds: [], members: false, presences: false, timezone: tz }, { limiter: new RelayLimiter(10, 5), isOwner: () => false, maxChars: 500 }),
    ...handoffTools({ things: nobody, starts: {}, callRoom: 'discord', pcFor: () => fakePc, callMusic: () => undefined, call: () => undefined, inCall: () => false, isOwner: () => true, canSee: async () => true, readable: false }),
    tellCallTool({ nameOf: () => 'Sam', inHerCall: () => false, call: () => undefined, isMember: async () => true, announce: async () => true, post: async () => 'general', limiter: { take: () => undefined, release() {} }, maxChars: 200 }),
    gameNightTool({ guild: () => undefined, allowedGuilds: [], presences: false, signups: {}, lastText: () => undefined, voiceChannel: () => undefined, cooldownMs: 1, maxMentions: 10, perUserPerHour: 4 }),
    gameServerTool([{ name: 'Survival', host: '192.0.2.10', port: 25565, kind: 'minecraft' }]),
    ...mediaTools({ plex: unused, sonarr: unused, radarr: unused, timezone: tz }),
    ...steamTools(new Steam({ accounts: {}, country: 'US', shareWithServer: false, timezone: tz })),
    ...headsUp.tools(),
    ...recap.tools(),
    headlines.tool(),
    briefing.tool(() => true, () => true),
  ];
  const tools = real.map((t) => ({
    ...t,
    run: async (args, signal, ctx) => {
      record(t.spec.name, args);
      if (answers[t.spec.name]) return answers[t.spec.name](args);
      if (LOCAL.has(t.spec.name)) return t.run(args, signal, ctx);
      return 'Nothing found.';
    },
  }));
  const creator = c.identity?.creator;
  const stableLines = [
    ...genderLines(c.botGender ?? 'female'),
    SOUND_RULE,
    ALARM_RULE,
    ...matureContext('always', false),
    ...music.musicRules(),
    ...(pc ? [PC_RULE] : []),
    HANDOFF_RULE,
    GAME_NIGHT_RULE,
  ];
  return {
    tools,
    taste,
    options: {
      spokenName: 'Adrian',
      writtenName: 'A.D.R.I.A.N.',
      timezone: tz,
      firstEventTimeoutMs: 12000,
      maxTokens: c.brain?.maxTokens ?? 500,
      maxToolRounds: 3,
      stablePrefix: true,
      filler: () => 'One sec.',
      ...(creator ? { creator: { name: creator, spoken: c.identity.creatorSpoken ?? creator, heardAs: c.identity.creatorHeardAs } } : {}),
      stableLines,
      context: (x) => [LANGS.en.prompt, music.musicState(stubPlayer), ...taste.context(x.userId, x.speaker)].filter(Boolean),
    },
  };
}
