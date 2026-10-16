import { describe, expect, it } from 'vitest';
import { eager } from '../src/core/eager.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('eager', () => {
  it('runs the producer ahead of a slow reader', async () => {
    const produced: number[] = [];
    async function* src() {
      for (let i = 0; i < 5; i++) {
        produced.push(i);
        yield i;
      }
    }
    const it = eager(src())[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(0);
    await sleep(5); // the reader is busy (speaking the first sentence)
    expect(produced).toEqual([0, 1, 2, 3, 4]); // the producer already finished
    const rest: number[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value);
    expect(rest).toEqual([1, 2, 3, 4]);
  });

  it('passes an error through after the items before it', async () => {
    async function* src() {
      yield 'a';
      throw new Error('boom');
    }
    const got: string[] = [];
    await expect(
      (async () => {
        for await (const x of eager(src())) got.push(x);
      })(),
    ).rejects.toThrow('boom');
    expect(got).toEqual(['a']);
  });

  it('waits for slow producers', async () => {
    async function* src() {
      await sleep(10);
      yield 1;
      await sleep(10);
      yield 2;
    }
    const got: number[] = [];
    for await (const x of eager(src())) got.push(x);
    expect(got).toEqual([1, 2]);
  });
});
