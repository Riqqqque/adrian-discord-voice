// The sources and tests are UTF-8 text. An editor or shell that reads them in
// another code page and writes them back turns each accented letter into
// several Latin-1 ones: the tests still pass, but they no longer test accented input.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|js|mjs)$/.test(name) ? [p] : [];
  });
}

// "Ã" or "Â" followed by what a second byte of UTF-8 turns into when it is
// read as Windows-1252: the mark of text encoded twice.
const TWICE = /[ÂÃ][\u0080-¿ŒœŠšŸŽžƒˆ˜–-›€™]/;

describe('source text', () => {
  const all = [...files(join(root, 'src')), ...files(join(root, 'test'))];

  it('finds the files', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('has nothing encoded twice', () => {
    const bad = all.filter((f) => TWICE.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1));
    expect(bad).toEqual([]);
  });

  it('ends every file with a newline', () => {
    const bad = all.filter((f) => !readFileSync(f, 'utf8').endsWith('\n')).map((f) => f.slice(root.length + 1));
    expect(bad).toEqual([]);
  });
});
