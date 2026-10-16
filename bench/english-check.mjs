// Which utterances trigger the Whisper second pass? Synthesized speech in
// each language → Parakeet (as the live bot hears it) → old vs new English
// check. English with names and slang should stay English (no second pass);
// Spanish is caught by its own check; zh/ja/vi must still go to Whisper.
//   LD_LIBRARY_PATH=node_modules/sherpa-onnx-linux-x64 node bench/english-check.mjs <models dir>
import sherpa from 'sherpa-onnx-node';
import { KokoroTts } from '../dist/speech/kokoro.js';
import { EnglishWords, looksSpanish } from '../dist/speech/language.js';
import { PiperTts, VoiceRouter } from '../dist/speech/piper.js';
import { ParakeetStt } from '../dist/speech/sherpa.js';

const [M] = process.argv.slice(2);
const kokoro = new KokoroTts({ modelDir: `${M}/kokoro-multi-lang-v1_0`, threads: 4 });
const piper = new PiperTts({ modelDir: `${M}/vits-piper-vi_VN-vais1000-medium`, modelFile: 'vi_VN-vais1000-medium.onnx', threads: 4 });
const tts = new VoiceRouter(kokoro, { vi_piper: piper });
const parakeet = await ParakeetStt.load({ modelDir: `${M}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, threads: 4 });
const english = new EnglishWords(`${M}/kokoro-multi-lang-v1_0/lexicon-us-en.txt`);

// The 0.10 rule, for comparison.
const lex = english;
function oldLooksEnglish(text) {
  if (/[぀-ヿ㐀-鿿가-힯]/.test(text)) return false;
  if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text)) return false;
  if (/[ñ¿¡]/i.test(text)) return false;
  const ws = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (!ws.length) return true;
  const known = ws.filter((w) => lex.words.has(w) || lex.words.has(w.replace(/'s$/, ''))).length;
  return ws.length < 3 ? known === ws.length : known / ws.length >= 0.7;
}

const corpus = [
  ['en', 'am_michael', 'play round two by jaeybxrd'],
  ['en', 'af_heart', 'yo is the atm server up right now'],
  ['en', 'am_michael', "what's kai cenat doing tonight"],
  ['en', 'af_heart', 'skip this one bro'],
  ['en', 'am_michael', "who's on the smp right now"],
  ['en', 'af_heart', 'remind me to feed biscuit in ten minutes'],
  ['en', 'am_michael', 'put on some phonk for the boys'],
  ['en', 'af_heart', 'how much is a ps5 pro these days'],
  ['en', 'am_michael', "tell sam he's washed at valorant"],
  ['en', 'af_heart', 'what is the score of the lakers game'],
  ['en', 'am_michael', 'can you play something like lil uzi vert'],
  ['en', 'af_heart', 'is jaeybxrd on spotify'],
  ['es', 'em_alex', '¿Cuál es la montaña más alta del mundo?'],
  ['es', 'ef_dora', 'Pon algo de música tranquila, por favor.'],
  ['zh', 'zm_yunxi', '世界上最高的山是什么？'],
  ['zh', 'zf_xiaobei', '今天天气怎么样？'],
  ['zh', 'zm_yunxi', '帮我放一首周杰伦的歌。'],
  ['ja', 'jm_kumo', 'せかいで いちばん たかい やまは なんですか？'],
  ['ja', 'jf_alpha', 'きょうの てんきは どうですか？'],
  ['ja', 'jm_kumo', 'おんがくを かけて ください。'],
  ['vi', 'vi_piper', 'Ngọn núi cao nhất thế giới là gì?'],
  ['vi', 'vi_piper', 'Hôm nay thời tiết thế nào?'],
  ['vi', 'vi_piper', 'Bật cho tôi một bài hát vui đi.'],
];

const tally = { old: { enWasted: 0, missed: 0 }, new: { enWasted: 0, missed: 0 } };
for (const [lang, voice, text] of corpus) {
  const q = await tts.synthesize(text, { voice, speed: 1 });
  const pcm = new sherpa.LinearResampler(q.sampleRate, 16000).flush(q.samples);
  const heard = (await parakeet.transcribe(pcm, 16000)).text;
  // Live order: English check, then the Spanish guess, else Whisper.
  const route = (isEn) => (isEn(heard) ? 'en' : looksSpanish(heard) ? 'es' : 'whisper');
  const o = route(oldLooksEnglish);
  const n = route((t) => english.looksEnglish(t));
  for (const [k, r] of [['old', o], ['new', n]]) {
    if (lang === 'en' && r === 'whisper') tally[k].enWasted++;
    if (lang !== 'en' && r === 'en') tally[k].missed++;
  }
  console.log(`${lang}  old ${o.padEnd(7)} new ${n.padEnd(7)} heard: ${heard.slice(0, 60)}`);
}
console.log(`\nEnglish sent to Whisper (wasted ~1 s): old ${tally.old.enWasted}/12, new ${tally.new.enWasted}/12`);
console.log(`Non-English taken as English (wrong language): old ${tally.old.missed}/11, new ${tally.new.missed}/11`);
