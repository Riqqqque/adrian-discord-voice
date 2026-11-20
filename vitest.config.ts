import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests wait for what they check rather than sleeping, so a passing run
    // never waits this long; the room is for a machine that is busy with
    // other work, where 5 s (the default) ran out for tests that take 100 ms.
    // Files that start bash, the CLI or a whole stack set longer limits.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
