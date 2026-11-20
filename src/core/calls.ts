// Counts calls to the outside services that bill per request but aren't in the
// dollar ledger (Tavily searches, Groq's second listen), for the dashboard.
// One listener at most (the service's); without one a call costs a branch.

export type CountedService = 'tavily' | 'groq-stt';

let sink: ((service: CountedService, status: number) => void) | undefined;

/** A request got an answer with this HTTP status; 0 when it got none. */
export function noteCall(service: CountedService, status: number): void {
  try {
    sink?.(service, status);
  } catch {
    /* counting must never break the call */
  }
}

/** fetch, counted: the status it answered with, or 0 (failed) when it never
 *  answered (network error, timeout). A call the caller called off itself
 *  (AbortError: barge-in, a dropped early listen, a race already won) isn't
 *  the service failing, so it isn't counted. Errors are rethrown as they came.
 *  `via`: the fetch to send it with (the kept-open connections); default the global one. */
export async function countedFetch(service: CountedService, url: string, init: RequestInit, via?: typeof fetch): Promise<Response> {
  let res: Response;
  try {
    res = await (via ?? globalThis.fetch)(url, init);
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name !== 'AbortError') noteCall(service, 0);
    throw e;
  }
  noteCall(service, res.status);
  return res;
}

/** Where counts go; undefined stops counting. */
export function onCall(f: typeof sink): void {
  sink = f;
}
