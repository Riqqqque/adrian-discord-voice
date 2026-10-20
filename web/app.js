// A.D.R.I.A.N. admin UI: setup code → admin account → setup wizard →
// dashboard. Plain DOM, no build step. Everything shown comes from the API
// and is inserted as text, never as HTML.

const app = document.getElementById('app');
let csrf = '';

// --- helpers --------------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : {};
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}

function msg(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

function busy(btn, fn) {
  return async (...a) => {
    btn.disabled = true;
    try {
      await fn(...a);
    } finally {
      btn.disabled = false;
    }
  };
}

const usd = (x) => (x == null ? '–' : `$${Number(x).toFixed(x < 0.1 ? 4 : 2)}`);
const ms = (x) => (x == null ? '–' : `${x} ms`);

function render(...nodes) {
  app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

// --- entry ----------------------------------------------------------------

async function start() {
  const s = await api('GET', '/api/session');
  if (s.loggedIn) {
    csrf = s.csrf;
    document.getElementById('who').replaceChildren(
      h('span', { class: 'muted small' }, s.username, ' '),
      h('button', { onclick: logout }, 'Log out'),
    );
    const st = await api('GET', '/api/status');
    const step = Number(new URLSearchParams(location.search).get('step'));
    if (step >= 0 && step < STEPS.length && location.search) return wizard(step);
    if (st.state === 'setup') return wizard(0);
    return dashboard();
  }
  document.getElementById('who').replaceChildren();
  return s.setupNeeded ? claimView() : loginView();
}

async function logout() {
  await api('POST', '/api/logout', {}).catch(() => {});
  csrf = '';
  start();
}

function claimView() {
  const code = h('input', { autocomplete: 'one-time-code', placeholder: 'XXXXX-XXXXX', autocapitalize: 'characters' });
  const user = h('input', { autocomplete: 'username', value: 'admin' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password' });
  const pass2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const out = h('div', { class: 'msg' });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Create admin account');
  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        if (pass.value !== pass2.value) return msg(out, "The passwords don't match.", 'bad');
        btn.disabled = true;
        try {
          const r = await api('POST', '/api/setup/claim', { code: code.value, username: user.value, password: pass.value });
          csrf = r.csrf;
          start();
        } catch (err) {
          msg(out, err.message, 'bad');
        } finally {
          btn.disabled = false;
        }
      },
    },
    h('h2', {}, 'Create the admin account'),
    h('p', { class: 'muted small' }, 'On the server, run ', h('code', {}, 'sudo adrian setup-code'), ' to see the one-time setup code. It expires after an hour.'),
    h('label', {}, 'Setup code'), code,
    h('label', {}, 'Username'), user,
    h('label', {}, 'Password (at least 10 characters)'), pass,
    h('label', {}, 'Password again'), pass2,
    btn, out,
  );
  render(h('h1', {}, 'Welcome'), h('p', { class: 'muted' }, 'This sets up the A.D.R.I.A.N. voice bot for your Discord server.'), form);
}

function loginView() {
  const user = h('input', { autocomplete: 'username' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const out = h('div', { class: 'msg' });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Log in');
  render(
    h('h1', {}, 'Log in'),
    h(
      'form',
      {
        class: 'card',
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          try {
            const r = await api('POST', '/api/login', { username: user.value, password: pass.value });
            csrf = r.csrf;
            start();
          } catch (err) {
            msg(out, err.message, 'bad');
          } finally {
            btn.disabled = false;
          }
        },
      },
      h('label', {}, 'Username'), user,
      h('label', {}, 'Password'), pass,
      btn, out,
    ),
  );
}

// --- wizard -----------------------------------------------------------------

const STEPS = ['Check', 'Discord', 'Language model', 'Search', 'Voice', 'Limits', 'Finish'];

async function wizard(step) {
  const { settings, presets, voices } = await api('GET', '/api/settings');
  const { secrets } = await api('GET', '/api/secrets');
  const has = (n) => secrets.some((s) => s.name === n);
  const nav = h('ol', { class: 'steps' }, STEPS.map((s, i) => h('li', { class: i === step ? 'on' : i < step ? 'done' : '' }, `${i + 1}. ${s}`)));
  const next = () => wizard(step + 1);
  const back = step > 0 ? h('button', { onclick: () => wizard(step - 1) }, 'Back') : null;
  const views = [stepCheck, stepDiscord, stepLlm, stepSearch, stepVoice, stepLimits, stepFinish];
  const body = await views[step]({ settings, presets, voices, has, next, back });
  render(h('h1', {}, 'Setup'), nav, body);
}

async function stepCheck({ next }) {
  const hw = await api('GET', '/api/check/hardware');
  const ok = hw.models.vad && hw.models.asr && hw.models.tts;
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'This computer'),
    h(
      'table',
      {},
      h('tr', {}, h('th', {}, 'CPU'), h('td', {}, `${hw.cpuModel} (${hw.cpuThreads} threads)`)),
      h('tr', {}, h('th', {}, 'Memory'), h('td', {}, `${hw.memTotalGiB} GiB total, ${hw.memFreeGiB} GiB free`)),
      h('tr', {}, h('th', {}, 'Free disk'), h('td', {}, hw.diskFreeGiB == null ? 'unknown' : `${hw.diskFreeGiB} GiB`)),
      h('tr', {}, h('th', {}, 'Node.js'), h('td', {}, hw.node)),
      h('tr', {}, h('th', {}, 'Speech models'), h('td', {}, ok ? h('span', { class: 'badge ok' }, 'installed') : h('span', { class: 'badge bad' }, 'missing'))),
    ),
    hw.warnings.map((w) => h('div', { class: 'msg warn' }, w)),
    h('p', { class: 'muted small' }, 'Speech recognition and the built-in voices run on this computer, and audio is never saved or sent anywhere. What leaves this computer: the transcribed question and recent conversation (to the language model, which also writes short memory notes about each person), web searches (if you add a search key), and spoken replies if you turn on the optional cloud voice.'),
    h('button', { class: 'primary', onclick: next }, 'Continue'),
  );
}

async function stepDiscord({ settings, has, next, back }) {
  const token = h('input', { type: 'password', autocomplete: 'off', placeholder: has('DISCORD_TOKEN') ? 'Saved. Paste a new one to replace it.' : 'Paste the bot token' });
  const out = h('div', { class: 'msg' });
  const after = h('div');
  const verifyBtn = h('button', { class: 'primary' }, 'Verify token');

  const showGuilds = (r) => {
    const parts = [h('p', {}, 'Signed in as ', h('strong', {}, r.botTag), '.')];
    if (r.publicBot) parts.push(h('div', { class: 'msg warn' }, 'This bot is public: anyone could add it to their server. In the Developer Portal, under Bot, turn Public Bot off.'));
    parts.push(h('p', { class: 'small' }, 'Add the bot to your server with this link (it asks only for Connect, Speak, Use Voice Activity and View Channels): ', h('a', { href: r.inviteUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Invite A.D.R.I.A.N.')));
    const guild = h('select', {}, h('option', { value: '' }, r.guilds.length ? 'Choose a server' : 'The bot is not in any server yet'), r.guilds.map((g) => h('option', { value: g.id, selected: g.id === settings.guildId }, g.name)));
    const channel = h('select', { disabled: true }, h('option', { value: '' }, 'Choose a server first'));
    const chOut = h('div', { class: 'msg' });
    const loadChannels = async () => {
      channel.disabled = true;
      if (!guild.value) return;
      try {
        const { channels } = await api('GET', `/api/check/channels?guild=${encodeURIComponent(guild.value)}`);
        channel.replaceChildren(h('option', { value: '' }, channels.length ? 'Choose a voice channel' : 'No voice channels visible to the bot'), channels.map((c) => h('option', { value: c.id, selected: c.id === settings.channelId }, c.name)));
        channel.disabled = false;
      } catch (e) {
        msg(chOut, e.message, 'bad');
      }
    };
    guild.addEventListener('change', loadChannels);
    if (guild.value) loadChannels();
    const save = h('button', { class: 'primary' }, 'Save and continue');
    save.addEventListener('click', busy(save, async () => {
      if (!guild.value || !channel.value) return msg(chOut, 'Choose a server and a voice channel.', 'bad');
      await api('PUT', '/api/settings', { guildId: guild.value, channelId: channel.value });
      next();
    }));
    const refresh = h('button', { onclick: () => verifyBtn.click() }, 'I added it, refresh');
    after.replaceChildren(...parts, h('label', {}, 'Server'), guild, h('label', {}, 'Voice channel to join'), channel, chOut, refresh, save);
  };

  verifyBtn.addEventListener('click', busy(verifyBtn, async () => {
    msg(out, 'Checking…');
    try {
      const r = await api('POST', '/api/check/discord', { token: token.value.trim() });
      if (!r.ok) return msg(out, r.error, 'bad');
      token.value = '';
      msg(out, 'Token is valid and saved.', 'ok');
      showGuilds(r);
    } catch (e) {
      msg(out, e.message, 'bad');
    }
  }));
  if (has('DISCORD_TOKEN')) queueMicrotask(() => verifyBtn.click());

  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Connect to Discord'),
    h('ol', { class: 'small' },
      h('li', {}, 'Open the ', h('a', { href: 'https://discord.com/developers/applications', target: '_blank', rel: 'noopener noreferrer' }, 'Discord Developer Portal'), ' and create an application named A.D.R.I.A.N.'),
      h('li', {}, 'Under Bot, press Reset Token and copy it. The privileged intents are optional: Message Content lets it read channels in text chat, Server Members and Presence let it see the member list and who is online.'),
      h('li', {}, 'Paste it here. It is stored on this server only and never shown again.')),
    h('label', {}, 'Bot token'), token,
    back, verifyBtn, out, after,
  );
}

function providerPicker(presets, current, { allowNone = false, has }) {
  const wrap = h('div');
  const key = h('input', { type: 'password', autocomplete: 'off' });
  const out = h('div', { class: 'msg' });
  const radios = [];
  const opts = [...presets.map((p) => ({ id: p.id, label: p.label, note: p.note, keySecret: p.keySecret }))];
  if (allowNone) opts.push({ id: 'none', label: 'No fallback', note: 'If the main provider fails, A.D.R.I.A.N. says it could not get an answer.' });
  const sel = () => radios.find((r) => r.checked)?.value;
  const update = () => {
    const p = opts.find((o) => o.id === sel());
    key.disabled = !p?.keySecret;
    key.placeholder = !p?.keySecret ? 'No key needed' : has(p.keySecret) ? 'Saved. Paste a new key to replace it.' : `Paste the ${p.label.split(' ')[0]} API key`;
  };
  for (const o of opts) {
    const r = h('input', { type: 'radio', name: `p-${allowNone}`, value: o.id, checked: o.id === current, onchange: update });
    radios.push(r);
    wrap.append(h('label', { class: 'choice' }, r, h('span', {}, h('strong', {}, allowNone ? o.label.replace(' (Recommended)', '') : o.label), h('br'), h('span', { class: 'muted small' }, o.note))));
  }
  update();
  const test = h('button', {}, 'Test');
  test.addEventListener('click', busy(test, async () => {
    const id = sel();
    if (!id || id === 'none') return msg(out, 'Nothing to test.', '');
    msg(out, 'Asking the model a test question…');
    try {
      const r = await api('POST', '/api/check/llm', { preset: id, key: key.value.trim() });
      if (!r.ok) return msg(out, r.error, 'bad');
      key.value = '';
      update();
      msg(out, `Works: "${r.reply}" in ${r.totalMs} ms. About ${usd(r.estCostPerAnswerUsd)} per answer at paid rates.`, 'ok');
    } catch (e) {
      msg(out, e.message, 'bad');
    }
  }));
  wrap.append(h('label', {}, 'API key'), key, test, out);
  return { el: wrap, value: sel, tested: () => out.classList.contains('ok') };
}

async function stepLlm({ settings, presets, has, next, back }) {
  const main = providerPicker(presets, settings.llm?.preset ?? 'claude', { has });
  const fb = providerPicker(presets, settings.fallback?.preset ?? (settings.llm ? 'none' : 'groq'), { allowNone: true, has });
  const out = h('div', { class: 'msg' });
  const save = h('button', { class: 'primary' }, 'Save and continue');
  save.addEventListener('click', busy(save, async () => {
    const m = main.value();
    const f = fb.value();
    const { secrets } = await api('GET', '/api/secrets');
    const need = presets.find((p) => p.id === m)?.keySecret;
    if (need && !secrets.some((s) => s.name === need)) return msg(out, 'Paste and test a key for the main provider first.', 'bad');
    if (f === m) return msg(out, 'Pick a different fallback, or No fallback.', 'bad');
    await api('PUT', '/api/settings', { llm: { preset: m }, fallback: { preset: f } });
    next();
  }));
  return h(
    'div', {},
    h('div', { class: 'card' }, h('h2', {}, 'Language model'), h('p', { class: 'muted small' }, 'Answers are written by a cloud model. Only the transcribed question and a short history of that person’s conversation are sent.'), main.el),
    h('div', { class: 'card' }, h('h2', {}, 'Fallback (optional)'), h('p', { class: 'muted small' }, 'Used automatically if the main provider is down or rate-limited.'), fb.el),
    h('div', {}, back, save, out),
  );
}

async function stepSearch({ settings, has, next, back }) {
  const on = h('input', { type: 'checkbox', checked: settings.search || !settings.llm });
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: has('TAVILY_API_KEY') ? 'Saved. Paste a new key to replace it.' : 'Paste the Tavily API key' });
  const out = h('div', { class: 'msg' });
  const test = h('button', {}, 'Test');
  test.addEventListener('click', busy(test, async () => {
    msg(out, 'Searching…');
    try {
      const r = await api('POST', '/api/check/search', { key: key.value.trim() });
      if (!r.ok) return msg(out, r.error, 'bad');
      key.value = '';
      msg(out, `Works (${r.ms} ms).`, 'ok');
    } catch (e) {
      msg(out, e.message, 'bad');
    }
  }));
  const save = h('button', { class: 'primary' }, 'Save and continue');
  save.addEventListener('click', busy(save, async () => {
    const { secrets } = await api('GET', '/api/secrets');
    if (on.checked && !secrets.some((s) => s.name === 'TAVILY_API_KEY')) return msg(out, 'Paste and test a Tavily key, or turn search off.', 'bad');
    await api('PUT', '/api/settings', { search: on.checked });
    next();
  }));
  return h(
    'div', { class: 'card' },
    h('h2', {}, 'Web search (Recommended)'),
    h('p', { class: 'muted small' }, 'Lets A.D.R.I.A.N. look up news, scores and other recent things. Tavily’s free plan includes 1,000 searches a month. Searches are read-only.'),
    h('label', { class: 'choice' }, on, 'Use web search'),
    h('label', {}, 'Tavily API key'), key, test, out,
    h('div', {}, back, save),
  );
}

async function stepVoice({ settings, voices, next, back }) {
  const english = voices.filter((v) => /^[ab][fm]_/.test(v));
  const voice = h('select', {}, english.map((v) => h('option', { value: v, selected: v === settings.voice.voice }, v + (v === 'af_heart' ? ' (Recommended)' : ''))));
  const speed = h('input', { type: 'range', min: '0.8', max: '1.2', step: '0.05', value: String(settings.voice.speed) });
  const speedLabel = h('span', { class: 'muted' }, `${settings.voice.speed}×`);
  speed.addEventListener('input', () => (speedLabel.textContent = `${speed.value}×`));
  const audio = h('audio', { controls: true, preload: 'none' });
  const out = h('div', { class: 'msg' });
  const play = h('button', {}, 'Preview');
  play.addEventListener('click', busy(play, async () => {
    msg(out, 'Generating (the first preview loads the voice model, about 10 seconds)…');
    try {
      const r = await fetch(`/api/voice-preview?voice=${encodeURIComponent(voice.value)}&speed=${encodeURIComponent(speed.value)}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json()).error || 'preview failed');
      audio.src = URL.createObjectURL(await r.blob());
      await audio.play().catch(() => {});
      msg(out, '');
    } catch (e) {
      msg(out, e.message, 'bad');
    }
  }));
  const save = h('button', { class: 'primary' }, 'Save and continue');
  save.addEventListener('click', busy(save, async () => {
    await api('PUT', '/api/settings', { voice: { voice: voice.value, speed: Number(speed.value) } });
    next();
  }));
  return h(
    'div', { class: 'card' },
    h('h2', {}, 'Voice'),
    h('p', { class: 'muted small' }, 'All voices are normalized to the same loudness.'),
    h('label', {}, 'Voice'), voice,
    h('label', {}, 'Speed ', speedLabel), speed,
    h('div', {}, play), audio, out,
    h('div', {}, back, save),
  );
}

async function stepLimits({ settings, next, back }) {
  const l = settings.limits;
  const tz = h('input', { value: settings.timezone !== 'UTC' ? settings.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone });
  const per = h('input', { type: 'number', min: '0', value: l.perUserPerHour });
  const day = h('input', { type: 'number', min: '0', step: '0.1', value: l.dailyUsd });
  const mon = h('input', { type: 'number', min: '0', step: '1', value: l.monthlyUsd });
  const out = h('div', { class: 'msg' });
  const save = h('button', { class: 'primary' }, 'Save and continue');
  save.addEventListener('click', busy(save, async () => {
    try {
      await api('PUT', '/api/settings', {
        timezone: tz.value.trim(),
        limits: { perUserPerHour: Number(per.value), dailyUsd: Number(day.value), monthlyUsd: Number(mon.value), maxRequestChars: l.maxRequestChars },
      });
      next();
    } catch (e) {
      msg(out, e.message, 'bad');
    }
  }));
  return h(
    'div', { class: 'card' },
    h('h2', {}, 'Limits'),
    h('p', { class: 'muted small' }, 'When a cap is reached A.D.R.I.A.N. says it is paused and stops calling the model until the next day or month. 0 means no limit.'),
    h('label', {}, 'Time zone (for "today" and the daily cap)'), tz,
    h('div', { class: 'row' },
      h('div', {}, h('label', {}, 'Questions per person per hour'), per),
      h('div', {}, h('label', {}, 'Daily cap (USD)'), day),
      h('div', {}, h('label', {}, 'Monthly cap (USD)'), mon)),
    out, h('div', {}, back, save),
  );
}

async function stepFinish({ back }) {
  const out = h('div', { class: 'msg' });
  const go = h('button', { class: 'primary' }, 'Start A.D.R.I.A.N.');
  go.addEventListener('click', busy(go, async () => {
    msg(out, 'Loading speech models and joining the voice channel. This takes about 20 seconds…');
    try {
      const r = await api('POST', '/api/restart', {});
      if (r.state === 'running') return dashboard();
      msg(out, r.state === 'setup' ? `Still missing: ${r.problems.join('; ')}` : `Could not start: ${r.error}`, 'bad');
    } catch (e) {
      msg(out, e.message, 'bad');
    }
  }));
  const st = await api('GET', '/api/status');
  return h(
    'div', { class: 'card' },
    h('h2', {}, 'Ready'),
    st.problems.length ? h('div', {}, h('p', {}, 'Before starting, fix:'), h('ul', {}, st.problems.map((p) => h('li', { class: 'msg bad' }, p)))) : h('p', {}, 'Everything is set. Start the bot, then say "Hey Adrian, what time is it?" in the voice channel.'),
    back, go, out,
  );
}

// --- dashboard --------------------------------------------------------------

let timer;
async function dashboard(tab = 'status') {
  clearInterval(timer);
  const tabs = ['status', 'settings', 'keys', 'logs', 'account'];
  const bar = h('div', { class: 'tabs' }, tabs.map((t) => h('button', { class: t === tab ? 'on' : '', onclick: () => dashboard(t) }, t[0].toUpperCase() + t.slice(1))));
  const body = h('div');
  render(h('h1', {}, 'Dashboard'), bar, body);
  const views = { status: dashStatus, settings: dashSettings, keys: dashKeys, logs: dashLogs, account: dashAccount };
  await views[tab](body);
  if (tab === 'status' || tab === 'logs') timer = setInterval(() => views[tab](body).catch(() => {}), 5000);
}

async function dashStatus(body) {
  const s = await api('GET', '/api/status');
  const state = { running: 'ok', starting: 'warn', setup: 'warn', failed: 'bad', stopped: 'bad' }[s.state];
  const sp = s.spend;
  const capRow = (label, val, cap) => {
    const fill = h('span');
    fill.style.width = `${cap ? Math.min(100, (val / cap) * 100).toFixed(1) : 0}%`; // CSSOM, allowed by the CSP
    return h('div', {}, h('div', { class: 'small' }, `${label}: ${usd(val)}${cap ? ` of ${usd(cap)}` : ' (no cap)'}`), cap ? h('div', { class: 'bar' }, fill) : null);
  };
  const restart = h('button', {}, 'Restart bot');
  restart.addEventListener('click', busy(restart, async () => {
    await api('POST', '/api/restart', {});
    dashboard('status');
  }));
  const lat = s.latency;
  body.replaceChildren(
    h('div', { class: 'card' },
      h('h2', {}, 'Status'),
      h('p', {}, h('span', { class: `badge ${state}` }, s.state), ' ', s.voiceReady ? h('span', { class: 'badge ok' }, 'in voice') : h('span', { class: 'badge warn' }, 'not in voice')),
      h('table', {},
        h('tr', {}, h('th', {}, 'Bot'), h('td', {}, s.botTag ?? '–')),
        h('tr', {}, h('th', {}, 'Version'), h('td', {}, s.version)),
        h('tr', {}, h('th', {}, 'Uptime'), h('td', {}, s.uptimeS == null ? '–' : `${Math.floor(s.uptimeS / 3600)} h ${Math.floor((s.uptimeS % 3600) / 60)} min`))),
      s.error ? h('div', { class: 'msg bad' }, s.error) : null,
      s.problems.length ? h('ul', {}, s.problems.map((p) => h('li', { class: 'msg warn' }, p))) : null,
      s.state === 'setup' ? h('button', { class: 'primary', onclick: () => wizard(0) }, 'Continue setup') : null,
      restart),
    h('div', { class: 'card' },
      h('h2', {}, 'Latency (last answers)'),
      h('table', {},
        h('tr', {}, h('th', {}, 'Stage'), h('th', {}, 'Median'), h('th', {}, '95th'), h('th', {}, 'Samples')),
        [['Speech recognition', lat.stt], ['Model first sentence', lat.llmFirst], ['Voice first sentence', lat.ttsFirst], ['End of speech to first audio', lat.speechEndToAudio]].map(([n, v]) =>
          h('tr', {}, h('td', {}, n), h('td', {}, ms(v.p50)), h('td', {}, ms(v.p95)), h('td', {}, v.n))))),
    h('div', { class: 'card' },
      h('h2', {}, 'Spending (estimated from token counts)'),
      capRow('Today', sp.today.costUsd, sp.limits.dailyUsd),
      capRow('This month', sp.monthUsd, sp.limits.monthlyUsd),
      h('p', { class: 'small muted' }, `${sp.today.requests} questions today. Limit: ${sp.limits.perUserPerHour || 'unlimited'} per person per hour.`),
      sp.history.length
        ? h('table', {}, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Questions'), h('th', {}, 'Cost')), sp.history.slice(0, 14).map((d) => h('tr', {}, h('td', {}, d.day), h('td', {}, d.requests), h('td', {}, usd(d.costUsd)))))
        : null),
  );
}

async function dashSettings(body) {
  // The wizard steps double as settings pages.
  body.replaceChildren(
    h('div', { class: 'card' },
      h('h2', {}, 'Settings'),
      h('p', { class: 'muted small' }, 'Changes take effect after Restart bot on the Status tab.'),
      STEPS.slice(1, 6).map((s, i) => h('button', { onclick: () => wizard(i + 1) }, s))),
  );
}

async function dashKeys(body) {
  const { secrets } = await api('GET', '/api/secrets');
  const known = ['DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'TAVILY_API_KEY', 'SPEECHIFY_API_KEY', 'PLEX_TOKEN', 'SONARR_API_KEY', 'RADARR_API_KEY'];
  const names = [...new Set([...known, ...secrets.map((s) => s.name)])];
  const rows = names.map((n) => {
    const set = secrets.some((s) => s.name === n);
    const input = h('input', { type: 'password', autocomplete: 'off', placeholder: set ? '••••••••  (saved, hidden)' : 'not set' });
    const out = h('span', { class: 'msg small' });
    const save = h('button', {}, set ? 'Replace' : 'Save');
    save.addEventListener('click', busy(save, async () => {
      if (!input.value.trim()) return;
      try {
        await api('PUT', `/api/secrets/${n}`, { value: input.value.trim() });
        dashboard('keys');
      } catch (e) {
        msg(out, e.message, 'bad');
      }
    }));
    const del = set ? h('button', { class: 'danger' }, 'Delete') : null;
    del?.addEventListener('click', busy(del, async () => {
      await api('DELETE', `/api/secrets/${n}`);
      dashboard('keys');
    }));
    return h('div', { class: 'card' }, h('h2', {}, n), input, save, del, out);
  });
  body.replaceChildren(h('p', { class: 'muted small' }, 'Keys are stored on this server only and are never shown again. Replacing a key takes effect after a restart.'), ...rows);
}

async function dashLogs(body) {
  const { lines } = await api('GET', '/api/logs');
  const pre = h('div', { class: 'logs' }, lines.slice(-200).join('\n'));
  body.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Recent log'), h('p', { class: 'muted small' }, 'Secrets are redacted. Full logs: journalctl -u adrian-voice'), pre));
  pre.scrollTop = pre.scrollHeight;
}

async function dashAccount(body) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const nxt = h('input', { type: 'password', autocomplete: 'new-password' });
  const out = h('div', { class: 'msg' });
  const go = h('button', { class: 'primary' }, 'Change password');
  go.addEventListener('click', busy(go, async () => {
    try {
      await api('POST', '/api/password', { current: cur.value, next: nxt.value });
      msg(out, 'Changed. Log in again.', 'ok');
      setTimeout(start, 1200);
    } catch (e) {
      msg(out, e.message, 'bad');
    }
  }));
  body.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Password'), h('label', {}, 'Current password'), cur, h('label', {}, 'New password (at least 10 characters)'), nxt, go, out));
}

start().catch((e) => render(h('div', { class: 'card msg bad' }, `Could not reach the server: ${e.message}`)));
