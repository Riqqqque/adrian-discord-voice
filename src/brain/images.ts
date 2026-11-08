// Pictures in tool results (a PC's screen). The model sees one exactly once:
// after the round that read it, it's dropped from the request, and it never
// reaches the session memory, which keeps only what was said.

import type { ChatMessage } from '../core/interfaces.js';

/** Left in place of a picture the model has already seen. */
export const IMAGE_SEEN = '(The picture was shown to you in the previous step and is no longer attached. Answer from what you saw; do not ask for it again.)';

/** Added where a model that can't take pictures would have had one. */
export const IMAGE_UNREADABLE = "(A picture came with this result, but you can't see pictures right now: the screen couldn't be read. Say so plainly; don't guess what's on it.)";

/** About what a 1568 px picture costs Claude, in input tokens. */
const IMAGE_TOKENS = 1_600;

/** Drop every picture the model has seen; true if there was one. */
export function stripImages(messages: ChatMessage[]): boolean {
  let any = false;
  for (const m of messages) {
    if (m.role === 'tool' && m.image) {
      delete m.image;
      m.content = `${m.content}\n${IMAGE_SEEN}`;
      any = true;
    }
  }
  return any;
}

/** Messages as text for a rough token count: a picture counts as its tokens,
 *  not as its base64. */
export function countable(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => (m.role === 'tool' && m.image ? { ...m, image: 'x'.repeat(IMAGE_TOKENS * 4) } : m));
}
