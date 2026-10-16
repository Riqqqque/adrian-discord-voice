import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnglishWords, LANGS, replyLang } from '../src/speech/language.js';

const lex = join(mkdtempSync(join(tmpdir(), 'lex-')), 'lexicon.txt');
writeFileSync(lex, ['what', 'is', 'the', 'weather', 'like', 'today', 'in', 'madrid', 'hola', 'set', 'a', 'timer', 'for', 'five', 'minutes'].map((w) => `${w} x`).join('\n'));
const en = new EnglishWords(lex);

describe('language', () => {
  it('tells English from other languages', () => {
    expect(en.looksEnglish('what is the weather like today')).toBe(true);
    expect(en.looksEnglish('set a timer for five minutes')).toBe(true);
    expect(en.looksEnglish('today')).toBe(true);
    expect(en.looksEnglish('lol')).toBe(true); // chat words count as English
    expect(en.looksEnglish('qué tiempo hace hoy en Madrid')).toBe(false);
    expect(en.looksEnglish('今天天气怎么样')).toBe(false);
    expect(en.looksEnglish('きょうの てんき')).toBe(false);
    expect(en.looksEnglish('hôm nay thời tiết thế nào')).toBe(false);
    expect(en.looksEnglish('kin chow hum nay thoy teet')).toBe(false); // Parakeet garbling non-English
  });

  it('maps detected languages to ones it can speak', () => {
    expect(replyLang('zh')).toBe('zh');
    expect(replyLang('ja')).toBe('ja');
    expect(replyLang('vi')).toBe('vi');
    expect(replyLang('es')).toBe('es');
    expect(replyLang('de')).toBe('en'); // understood, answered in English
    expect(LANGS.ja.prompt).toContain('no kanji');
  });
});

describe('language fixes', () => {
  it('treats a short unknown word as not English, and spots Spanish', async () => {
    const { looksSpanish, stripWakeLead } = await import('../src/speech/language.js');
    expect(en.looksEnglish('Shizong.')).toBe(false);
    expect(en.looksEnglish('the weather')).toBe(true);
    expect(looksSpanish('¿cuál es la montaña más alta del mundo?')).toBe(true);
    expect(looksSpanish('pon un temporizador de cinco minutos para la pizza')).toBe(true);
    expect(looksSpanish('what is the tallest mountain')).toBe(false);
    expect(stripWakeLead('Này,  Dinh, một núi cao nhất')).toBe('Dinh, một núi cao nhất'.replace(/^Dinh, /, 'Dinh, '));
    expect(stripWakeLead('嘿阿德里安，世界上最高的山是什么？')).toBe('世界上最高的山是什么？');
    expect(stripWakeLead('世界上最高的山是什么？')).toBe('世界上最高的山是什么？');
  });
});
