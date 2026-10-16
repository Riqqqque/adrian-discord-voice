// Fix for discord.js issue #11653 in @discordjs/voice 0.19.2.
//
// When the bot joins a channel while someone is already speaking, the DAVE
// group's last transition id is 0. The decrypt path recovers from repeated
// failures with `if (this.lastTransitionId)`, which treats 0 as "no
// transition", so it rethrows forever and that user's audio never decrypts.
// This patch makes the check `!== undefined`.
//
// Runs on postinstall. Idempotent. Refuses to touch any other version so a
// library upgrade can't silently keep or break the patch.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// The package doesn't export ./package.json; resolve its entry (dist/index.js)
// and step up to the package root.
const dir = dirname(dirname(require.resolve('@discordjs/voice')));
const pkgPath = join(dir, 'package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const EXPECTED = '0.19.2';

const BROKEN = 'if (this.lastTransitionId) this.recoverFromInvalidTransition(this.lastTransitionId);';
const FIXED =
  'if (this.lastTransitionId !== undefined) this.recoverFromInvalidTransition(this.lastTransitionId);';

if (version !== EXPECTED) {
  console.error(
    `patch-voice: @discordjs/voice is ${version}, expected ${EXPECTED}. ` +
      'Check whether issue #11653 is fixed upstream, then update or remove this patch.',
  );
  process.exit(1);
}

for (const file of ['dist/index.js', 'dist/index.mjs']) {
  const path = join(dir, file);
  const src = readFileSync(path, 'utf8');
  if (src.includes(FIXED)) {
    console.log(`patch-voice: ${file} already patched`);
    continue;
  }
  const count = src.split(BROKEN).length - 1;
  if (count !== 1) {
    console.error(`patch-voice: expected 1 match in ${file}, found ${count}; not patching`);
    process.exit(1);
  }
  writeFileSync(path, src.replace(BROKEN, FIXED));
  console.log(`patch-voice: patched ${file}`);
}
