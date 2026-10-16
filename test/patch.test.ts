import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const dir = dirname(dirname(require.resolve('@discordjs/voice')));

describe('DAVE transition-0 fix (#11653)', () => {
  it('is applied to both builds of @discordjs/voice', () => {
    for (const f of ['dist/index.js', 'dist/index.mjs']) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src).toContain('if (this.lastTransitionId !== undefined) this.recoverFromInvalidTransition');
      expect(src).not.toContain('if (this.lastTransitionId) this.recoverFromInvalidTransition');
    }
  });
});
