// A picture a PC sent with an action result (pc_screen). Checked before the
// model gets it: JPEG or PNG only, at most MAX_IMAGE_BYTES, and the bytes
// have to be what the label says. Anything else is dropped, and the model is
// told why so it can say so.

import type { ToolImage } from '../core/interfaces.js';

/** Largest picture accepted, decoded. PCs aim for under 1 MB. */
export const MAX_IMAGE_BYTES = 1_500_000;
/** Its base64 length, which is checked before decoding anything. */
const MAX_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

const MAGIC: Record<ToolImage['mime'], number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

/** The picture, or why it was dropped. Nothing at all when none was sent. */
export function readImage(raw: unknown): { image?: ToolImage; problem?: string } {
  if (raw === undefined || raw === null) return {};
  const r = raw as { mime?: unknown; data?: unknown };
  const mime = r.mime;
  if (typeof raw !== 'object' || (mime !== 'image/jpeg' && mime !== 'image/png') || typeof r.data !== 'string') {
    return { problem: "The picture was in a format I can't read, so it was left out." };
  }
  const data = r.data;
  if (data.length > MAX_BASE64) return { problem: 'The picture was too big to read, so it was left out.' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return { problem: 'The picture arrived damaged, so it was left out.' };
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return { problem: 'The picture was too big to read, so it was left out.' };
  if (!MAGIC[mime].every((b, i) => bytes[i] === b)) return { problem: "The picture wasn't what it claimed to be, so it was left out." };
  return { image: { mime, data } };
}
