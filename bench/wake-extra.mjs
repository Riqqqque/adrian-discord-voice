// Builds the wake word's extra corpus (16 kHz mono WAV + labels.jsonl): the
// shapes the sidetalk corpus has one phrase of, or none. Each phrase is said by
// 4 Kokoro voices (rotating through 20 English ones), two of them with the
// commas left out (Kokoro pauses at a comma and Parakeet echoes it back, so
// a rule mustn't lean on it), at a varied speed, roughed up like a desk mic.
//   node bench/wake-extra.mjs <models dir> <out dir>
// Classes (kind in brackets; "undecidable" is said to a person by the bare
// name, which no text rule can tell apart from a request to her):
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { KokoroTts } from '../dist/speech/kokoro.js';

export const PHRASES = {
  // [wake] the bare name, then a request
  'wake-bare': [
    'Adrian, what time is it?', 'Adrian, play some music.', 'Adrian, can you pause the music?', 'Adrian, is it going to rain tomorrow?',
    'Adrian, will you set a timer for ten minutes?', 'Adrian, are you there?', 'Adrian, turn the volume down.', "Adrian, what's the weather like?",
    'Adrian, did the Lakers win last night?', 'Adrian, how do I make pancakes?', 'Adrian, skip this song.', 'Adrian, does the Minecraft server work right now?',
    'Adrian, who sings this song?', 'Adrian, was that song by Drake?', 'Adrian, could you open Spotify?', 'Adrian, tell me a joke.',
    'Adrian, would you remind me to call my mom?', 'Adrian, has anyone joined the server?',
  ],
  // [wake] greeting + name, then a question starting with a helper verb
  'wake-aux': [
    'Hey Adrian, is it going to snow this weekend?', 'Hey Adrian, did the Lakers win?', 'Hey Adrian, will it be sunny tomorrow?', 'Hey Adrian, does pizza freeze well?',
    'Hey Adrian, can you play some jazz?', 'Hey Adrian, are there any new messages?', 'Okay Adrian, was that the last song?', 'Hey Adrian, has anyone joined the call?',
    'Hey Adrian, could you turn it up?', 'Hi Adrian, would you set an alarm for seven?', 'Hey Adrian, is Marco online?', 'Yo Adrian, can I ask you something?',
    'Hey Adrian, do you know any good movies?', 'Hey Adrian, should I bring an umbrella?', 'Hey Adrian, is the server down?', 'Okay Adrian, will you remind me at noon?',
    'Hey Adrian, were the Knicks playing tonight?', 'Hey Adrian, is there a timer running?',
  ],
  // [wake] the name at the end, as an address
  'wake-end': [
    'What time is it, Adrian?', 'Thanks, Adrian.', 'Play some music, Adrian.', 'Can you turn it down, Adrian?', 'Good morning, Adrian.', "What's up, Adrian?",
    "How's it going, Adrian?", 'Set a timer for five minutes, Adrian.', 'Are you there, Adrian?', "What's the weather like today, Adrian?", 'Skip this song, Adrian.',
    'Thank you so much, Adrian.', 'Pause the music please, Adrian.', 'You awake, Adrian?', 'Tell me a joke, Adrian.', 'Good night, Adrian.',
    'Who won the game last night, Adrian?', 'Turn off the lights, Adrian.',
  ],
  // [wake] the name in the middle, as an address, after a lead-in
  'wake-mid': [
    'Wait, Adrian, pause the music.', "So Adrian, what's the score?", 'Okay so, hey Adrian, set a timer for ten minutes.', 'Hold on guys. Adrian, what time is it?',
    'Um, Adrian, can you skip this?', 'Guys, guys, hey Adrian, turn it down.', 'Alright, Adrian, play the next song.', "Yeah, okay, Adrian, what's the weather?",
    'Hmm, actually Adrian, cancel that timer.', 'Wait wait, Adrian, stop the music.', "One sec, hey Adrian, what's two plus two?", 'Okay, Adrian, lock my computer.',
    'Bro hold on, Adrian, how many ounces are in a pound?', 'Right, Adrian, open Spotify.', 'Sorry, Adrian, what was that?',
  ],
  // [wake] plain wakes with other greetings and short commands
  'wake-plain': [
    "Hey Adrian, what's on my calendar today?", 'Okay Adrian, skip this song.', 'Hi Adrian, set a timer for twenty minutes.', 'Yo Adrian, play some Drake.',
    'Hello Adrian, can you hear me?', 'Hey Adrian, open Discord.', 'Hey there Adrian, what time is it?', 'Hey hey Adrian, turn it up.',
    "Excuse me Adrian, what's the time?", 'Hey Adrian?', 'Adrian?', "Morning Adrian, what's the weather?", "Hey Adrian, umm, what's the capital of Peru?",
    'Hey Adrian, pause.', 'Hey Adrian, stop.', 'Hey Adrian, louder.',
  ],
  // [hard] greeting + name, then a statement about Adrian
  hard: [
    'Hey, Adrian is being weird again.', 'Okay, Adrian was right about that.', 'Hey, Adrian just left the call.', 'Yo, Adrian is lagging so hard.',
    "Okay, Adrian can't hear us anyway.", 'Hey, Adrian will be back in five minutes.', 'Hi, Adrian has it covered.', 'Okay, Adrian said no.',
    'Hey, Adrian is going to love this.', 'Hey, Adrian was talking about you.', "Okay, Adrian doesn't know that one.", 'Yo, Adrian keeps cutting out.',
    'Hey, Adrian is so slow today.', "Okay, Adrian thinks it's going to rain.", 'Hey, Adrian already answered that.', 'Hey, Adrian and I are going to play later.',
    "Okay, Adrian won't stop talking.", 'Hey, Adrian never plays the right song.',
  ],
  // [notWake] the name at the end, as the object
  'about-end': [
    'Have you seen Adrian?', 'Where is Adrian?', 'I was just talking with Adrian.', 'We should ask Adrian.', 'Go ask Adrian.', 'This one is for Adrian.',
    'Say thanks to Adrian.', "I'm playing with Adrian.", 'Did you message Adrian?', "Let's invite Adrian.", "That's what I told Adrian.", 'Nobody likes Adrian.',
    "I'm going to mute Adrian.", 'Who is Adrian?', 'I bet it was Adrian.', 'Same as Adrian.', "Don't listen to Adrian.", 'You sound just like Adrian.',
  ],
  // [notWake] the bare name, then a statement about Adrian
  'about-start': [
    'Adrian went home early.', 'Adrian is always late.', 'Adrian will be here soon.', "Adrian can't come tonight.", 'Adrian made dinner for everyone.',
    'Adrian got a new job.', 'Adrian was here yesterday.', 'Adrian thinks we should go.', 'Adrian and Sam are coming over.', 'Adrian told me about it.',
    'Adrian plays way too much Fortnite.', 'Adrian has a really nice car.', 'Adrian needs to fix his mic.', 'Adrian broke the printer again.',
    'Adrian likes the blue one.', 'Adrian wants pizza tonight.',
  ],
  // [notWake] the name in the middle, talked about
  'about-mid': [
    'I think Adrian left already.', 'Me and Adrian are going out.', 'So yeah, Adrian is not coming.', 'My friend Adrian said that.',
    'Honestly Adrian was kind of right.', 'Wait, Adrian got banned?', 'Did you hear what Adrian did?', 'Why does Adrian always do that?',
    "Okay so Adrian said he'd be late.", 'Tomorrow Adrian is driving.', 'Last night Adrian won every round.', 'Yeah Adrian knows the way.',
  ],
  // [notWake] other names that sound close
  soundalike: [
    'Hey Adrienne, how was your weekend?', 'Hey Aiden, you there?', 'Hey Damian, nice shot.', "Hey Ryan, what's up?", 'Hey Adam, pass the chips.',
    'Hey Andrea, are you coming?', 'Hey Adrianna, happy birthday.', "Hey Darian, let's go.", 'Hey Brian, you ready?', 'Hey Audrey, what time is it?',
    'Hey Jaden, grab the ball.', "Hey Aidan, what's up?", 'Hey Dorian, over here.', 'Hey Andrew, can you hear me?', 'Hey Adriel, good game.',
    "Hey Daria, how's it going?",
  ],
  // [undecidable] the bare name, said to a person
  undecidable: [
    'Adrian, come over here.', 'Adrian, grab me a drink.', 'Adrian, look at this.', "Adrian, you're up next.", 'Adrian, hurry up.',
    'Adrian, give me back my charger.', 'Adrian, open the door.', 'Adrian, wait for me.',
  ],
};
export const KIND = { hard: 'hard', 'about-end': 'notWake', 'about-start': 'notWake', 'about-mid': 'notWake', soundalike: 'notWake', undecidable: 'undecidable' };
export const kindOf = (cls) => KIND[cls] ?? 'wake';

const VOICES = [
  'af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_bella', 'am_adam', 'bf_isabella', 'bm_lewis', 'af_nicole', 'am_eric',
  'af_sarah', 'am_liam', 'bf_alice', 'bm_daniel', 'af_river', 'am_onyx', 'af_jessica', 'am_puck', 'bf_lily', 'bm_fable',
];

let seed = 4242;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
function noise(x, snrDb) {
  const target = rms(x) / 10 ** (snrDb / 20);
  let b = 0;
  const n = Float32Array.from(x, () => ((b = b * 0.98 + (rnd() - 0.5) * 0.4), b + (rnd() - 0.5) * 0.3));
  const k = target / (rms(n) || 1);
  return Float32Array.from(x, (v, i) => v + n[i] * k);
}
function echo(x) {
  const y = Float32Array.from(x);
  for (const [ms, g] of [[23, 0.35], [57, 0.25], [111, 0.15], [173, 0.08]]) {
    const d = Math.round((ms / 1000) * 16000);
    for (let i = d; i < x.length; i++) y[i] += x[i - d] * g;
  }
  return y;
}
function headset(x) {
  let lp = 0, hpIn = 0, hpOut = 0;
  return Float32Array.from(x, (v) => {
    hpOut = 0.95 * (hpOut + v - hpIn); hpIn = v;
    lp += 0.55 * (hpOut - lp);
    return Math.tanh(lp * 2.2) / 2.2;
  });
}
const DEGRADE = [
  ['noise', (x) => noise(x, 18)],
  ['echo+noise', (x) => noise(echo(x), 15)],
  ['headset', (x) => noise(headset(x), 20)],
  ['quiet+noise', (x) => noise(Float32Array.from(x, (v) => v * 0.25), 12)],
];
const SPEEDS = [1, 1.15, 0.95, 1.25];

function wav(samples, rate = 16000) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b;
}

if (process.argv[1]?.endsWith('wake-extra.mjs')) {
  const [M, OUT] = process.argv.slice(2);
  if (!M || !OUT) {
    console.error('usage: node bench/wake-extra.mjs <models dir> <out dir>');
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const kokoro = new KokoroTts({ modelDir: join(M, 'kokoro-multi-lang-v1_0'), threads: 2 });
  const labels = [];
  let v = 0;
  for (const [cls, list] of Object.entries(PHRASES)) {
    for (const [pi, text] of list.entries()) {
      for (let k = 0; k < 4; k++) {
        const voice = VOICES[v++ % VOICES.length];
        const said = k >= 2 ? text.replace(/,/g, '') : text;
        const speed = SPEEDS[(pi + k) % SPEEDS.length];
        const q = await kokoro.synthesize(said, { voice, speed });
        const s = new sherpa.LinearResampler(q.sampleRate, 16000).flush(q.samples);
        const pad = new Float32Array(4800); // 0.3 s of room tone each side
        const full = new Float32Array(pad.length * 2 + s.length);
        full.set(s, pad.length);
        const [dname, d] = DEGRADE[(pi + k) % DEGRADE.length];
        const id = `${cls}-${String(pi).padStart(2, '0')}-${k}-${voice}-${dname}`;
        writeFileSync(join(OUT, `${id}.wav`), wav(d(full)));
        labels.push({ id: `extra/${id}`, file: `${id}.wav`, cls, kind: kindOf(cls), phrase: `${cls}-${pi}`, text, commas: k < 2 });
      }
    }
    console.log(`${cls}: ${list.length} phrases`);
  }
  writeFileSync(join(OUT, 'labels.jsonl'), labels.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`${labels.length} clips`);
}
