// Read an async stream as fast as it produces, buffering for a slower
// reader. The model's answer is pulled in at its own pace while the voice
// speaks earlier sentences, so a generation time limit never counts time
// spent speaking.

export function eager<T>(src: AsyncIterable<T>): AsyncIterable<T> {
  const buf: T[] = [];
  let ended = false;
  let failed: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  void (async () => {
    try {
      for await (const x of src) {
        buf.push(x);
        notify();
      }
    } catch (e) {
      failed = { error: e };
    } finally {
      ended = true;
      notify();
    }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buf.length) {
          yield buf.shift()!;
          continue;
        }
        if (failed) throw failed.error;
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}
