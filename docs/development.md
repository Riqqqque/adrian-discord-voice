# Development

## Requirements

- Node.js 22.12 or newer (22.x LTS) and npm
- Linux x86_64 to build release bundles and to run the speech models. TypeScript checks and unit tests also run on Windows and macOS.
- `ffmpeg` for music

## Build and test

```bash
npm ci            # also patches @discordjs/voice 0.19.2 (scripts/patch-voice.mjs, issue #11653)
npm run build     # TypeScript → dist/
npx tsc --noEmit -p .
npx vitest run    # unit tests (no network, no models)
```

The unit tests cover:
- the conversation controller, the wake check and the local intents;
- the orchestrator (tool rounds, caching layout, retries, SILENT);
- the model adapters, the mixer and the speaker;
- music (search parsing, queue, radio, autoplay, Plex);
- reminders, notes, games, the spend ledger and the config schema;
- key-purpose rules, the admin API and the host check.

## Running from a checkout

The bot needs the speech models. The installer gets them with `packaging/downloads.sh`, and you can do the same by hand:

```bash
mkdir -p ~/adrian-data/models /tmp/adrian-dl
bash -c '. packaging/downloads.sh; install_models ~/adrian-data/models /tmp/adrian-dl'

export ADRIAN_CONFIG=~/adrian-data/config.json ADRIAN_STATE=~/adrian-data/state ADRIAN_MODELS=~/adrian-data/models
export LD_LIBRARY_PATH=$PWD/node_modules/sherpa-onnx-linux-x64
node dist/app/main.js   # admin page on 127.0.0.1:8790; the wizard writes the config
```

Don't run a development copy with the same bot token as an installed service: two copies fight over the voice connection.

## Building a release bundle

On Linux x86_64 with Node 22:

```bash
packaging/package.sh release/
# → release/adrian-voice-<version>-linux-x64.tar.gz and .sha256
```

It runs `npm ci`, builds, drops the dev dependencies, and packs the app with its `packaging/` folder. Install it with `sudo packaging/install.sh --bundle …`, or upgrade with `sudo adrian update …`.

Container tests (Docker, systemd inside a throwaway container):
- `test-env/clean-install-test.sh`: install from scratch.
- `test-env/update-test.sh`: update and rollback.
- `test-env/compose-test.sh`: the Docker Compose setup.

## Benchmarks (`bench/`)

These run against real models and services. Most take the path to a config with keys as their first argument.

| Script | Measures |
|---|---|
| `cache-check.mjs` | Prompt-cache reads and writes over a conversation |
| `first-audio.mjs` | Time to the first audio (model + cloud voice) |
| `slow-speaker.mjs` | Whether a slow voice makes the model time out |
| `music-search.mjs`, `music-kinds.mjs`, `music-e2e.mjs`, `music-intent.mjs` | Music: search quality, each request type, through the model |
| `mixer-stall.mjs`, `music-check.mjs` | Playback continuity under event-loop stalls, levels and ducking |
| `english-check.mjs` | Which utterances get the Whisper second pass |
| `creator-check.mjs`, `memory-check.mjs` | Identity and memory behaviour |
| `tts-speed.mjs`, `asr-speed.mjs`, `level-check.mjs` | Local speech speed and loudness |

## Updating the pinned downloads

`packaging/downloads.sh` pins every download by URL and SHA-256. When YouTube breaks the pinned yt-dlp:
1. Take the new version and its checksum from that release's `SHA2-256SUMS`.
2. Update the `yt-dlp_linux` line.
3. Ship a release.

## Conventions

- **Strict TypeScript.** Zod validates all config, and every setting has a default.
- **Keys.** Never log one or put it in an argument or URL. A setting only references keys meant for its own purpose (`SECRET_PURPOSE` in `src/config.ts`).
- **Integrations stay read-only.**
- **Paid calls** go through the spend ledger.
