// Counts calls to the outside services that bill per request but aren't in the
// dollar ledger (Tavily searches, Groq's second listen), for the dashboard.
// One listener at most (the service's); without one a call costs a branch.

export type CountedService = 'tavily' | 'groq-stt';

let sink: ((service: CountedService, status: number) => void) | undefined;

/** A request got an answer with this HTTP status. */
export function noteCall(service: CountedService, status: number): void {
  try {
    sink?.(service, status);
  } catch {
    /* counting must never break the call */
  }
}

/** Where counts go; undefined stops counting. */
export function onCall(f: typeof sink): void {
  sink = f;
}
