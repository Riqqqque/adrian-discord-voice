import { describe, expect, it } from 'vitest';
import { redactVoiceDebug } from '../src/transport/discord.js';

describe('voice debug redaction', () => {
  it('removes the media key, token and session id', () => {
    const raw =
      '[NW] [WS] << {"op":4,"d":{"secure_frames_version":1,"secret_key":[164,40,32,146],"mode":"x"}}' +
      ' >> {"op":0,"d":{"server_id":"1","session_id":"b93f46da","token":"abc.def"}}';
    const out = redactVoiceDebug(raw);
    expect(out).not.toMatch(/164,40|b93f46da|abc\.def/);
    expect(out).toContain('"secret_key":"[redacted]"');
    expect(out).toContain('"session_id":"[redacted]"');
    expect(out).toContain('"token":"[redacted]"');
    expect(out).toContain('"server_id":"1"');
  });

  it('also handles the JSON-escaped form inside log lines', () => {
    const escaped = '{\\"secret_key\\":[1,2,3],\\"session_id\\":\\"zz9\\"}';
    const out = redactVoiceDebug(escaped);
    expect(out).not.toMatch(/1,2,3|zz9/);
  });
});
