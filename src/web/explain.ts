// Plain words for the reasons the voice stack fails to start. The raw error
// (from discord.js, the speech models or the network) is kept as it is; this
// adds what the person can do about it. Shown on the dashboard, after Start in
// the wizard, and by `adrian doctor`.

interface Rule {
  test: RegExp;
  fix: string;
}

const RULES: Rule[] = [
  {
    test: /invalid token|TokenInvalid|\b401\b|Unauthorized/i,
    fix: 'Discord rejected the bot token. In the Discord Developer Portal, open your application, go to Bot, press Reset Token, and paste the new token on the Discord step of the setup.',
  },
  {
    test: /disallowed intents|\b4014\b/i,
    fix: 'Discord refused a privileged intent. In the Developer Portal, under Bot, turn on the Privileged Gateway Intents you enabled in the config (Message Content, Server Members, Presence), or turn those features off.',
  },
  {
    test: /Unknown Guild|\b10004\b/i,
    fix: "The bot isn't in the chosen Discord server anymore. Open the Discord step of the setup, use the invite link to add it again, and pick the server.",
  },
  {
    test: /Unknown Channel|\b10003\b/i,
    fix: "The chosen voice channel doesn't exist anymore. Pick another one on the Discord step of the setup.",
  },
  {
    test: /Missing Access|Missing Permissions|\b5000[13]\b/i,
    fix: "The bot isn't allowed into the voice channel. In Discord, open the channel's settings, then Permissions, and allow the bot (or its role) View Channel, Connect and Speak.",
  },
  {
    test: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    fix: "This server can't look up discord.com: it is offline or its DNS isn't working. It tries again by itself; check the server's internet connection.",
  },
  {
    test: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|timed? ?out/i,
    fix: "Discord couldn't be reached just now. It tries again by itself. If it keeps happening, check that this server's firewall allows outgoing connections (HTTPS, and UDP for voice).",
  },
  {
    test: /ENOMEM|out of memory|Cannot allocate memory|heap limit/i,
    fix: 'The server ran out of memory. Close other programs, or turn the extra language voices off: sudo adrian config languages false, then restart.',
  },
  {
    test: /EACCES|permission denied|EPERM/i,
    fix: "The service can't read or write one of its own files (usually after a command was run as root by hand). Run sudo adrian doctor: it prints the command that gives the files back.",
  },
  {
    test: /^Config |is not valid JSON|config needs/i,
    fix: 'The config file has a mistake in it. sudo adrian check names the setting; fix it with sudo adrian config, or undo the hand edit in /etc/adrian/config.json.',
  },
  {
    test: /\.onnx|tokens\.txt|voices\.bin|model.*(not found|missing|no such)|ENOENT|No such file/i,
    fix: 'Speech model files are missing or damaged. Run sudo adrian update (or the installer again): it downloads whatever is missing. sudo adrian doctor lists which are there.',
  },
];

/** What to do about a failed start, or undefined when the reason isn't a known one. */
export function explainStartError(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  return RULES.find((r) => r.test.test(error))?.fix;
}
