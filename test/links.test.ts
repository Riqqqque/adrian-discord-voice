import { describe, expect, it } from 'vitest';
import { linksLine, mediaLinksIn, parseMediaLink, PLAY_THAT_LINK, RecentLinks, spotifyItem } from '../src/features/links.js';

describe('pasted links', () => {
  it('knows the playable sites and nothing else', () => {
    expect(parseMediaLink('https://youtu.be/dQw4w9WgXcQ?si=abc')).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(parseMediaLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s')?.kind).toBe('youtube');
    expect(parseMediaLink('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM')?.kind).toBe('youtube');
    expect(parseMediaLink('https://youtube.com/shorts/dQw4w9WgXcQ')?.kind).toBe('youtube');
    expect(parseMediaLink('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG')?.kind).toBe('youtube-list');
    expect(parseMediaLink('https://soundcloud.com/artist/some-track?utm=1')).toEqual({ kind: 'soundcloud', url: 'https://soundcloud.com/artist/some-track' });
    expect(parseMediaLink('https://band.bandcamp.com/album/name')?.kind).toBe('bandcamp');
    expect(parseMediaLink('https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b?si=x')?.kind).toBe('spotify');
    expect(parseMediaLink('https://open.spotify.com/intl-de/album/4yP0hdKOZPNshxUOjY0cZj')?.kind).toBe('spotify');
    // anything else, including look-alikes and local addresses, is ignored
    for (const bad of [
      'http://192.168.1.10/video.mp4',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'https://user:pw@youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com:8443/watch?v=dQw4w9WgXcQ',
      'file:///etc/passwd',
      'https://example.com/song.mp3',
      'https://www.youtube.com/@channel',
    ])
      expect(parseMediaLink(bad), bad).toBeUndefined();
  });

  it('finds links in a message, including <unembedded> ones', () => {
    const l = mediaLinksIn('yo listen <https://youtu.be/dQw4w9WgXcQ> and https://soundcloud.com/a/b also https://example.com');
    expect(l.map((x) => x.kind)).toEqual(['youtube', 'soundcloud']);
  });

  it("picks the asker's own latest link, else the server's latest", () => {
    let t = 0;
    const r = new RecentLinks(() => t);
    const yt = parseMediaLink('https://youtu.be/dQw4w9WgXcQ')!;
    const sc = parseMediaLink('https://soundcloud.com/a/b')!;
    r.add({ link: yt, userId: 'me', name: 'Rique', guildId: 'g', channelId: 'c' });
    t = 60_000;
    r.add({ link: sc, userId: 'sam', name: 'Sam', guildId: 'g', channelId: 'c' });
    expect(r.latestFor('me', 'g')?.link.kind).toBe('youtube');
    expect(r.latestFor('bob', 'g')?.link.kind).toBe('soundcloud');
    expect(r.latestFor('bob', 'other')).toBeUndefined();
    t = 32 * 60_000;
    expect(r.latestFor('me', 'g')).toBeUndefined();
    expect(linksLine(r.forPrompt('sam', 'g'), t)).toEqual([]);
  });

  it('hears the ways people ask', () => {
    for (const s of [
      'play that link',
      'Play the link I just sent.',
      'hey adrian play the video I posted',
      'can you play that song he sent',
      'queue up the link I pasted in chat',
      'put on what I just sent',
      'play my link please',
    ])
      expect(PLAY_THAT_LINK.test(s), s).toBe(true);
    for (const s of ['play that funky music', 'play the weeknd', 'what was that link', 'play the link between us by some band'])
      expect(PLAY_THAT_LINK.test(s), s).toBe(false);
  });

  it('reads a Spotify song or album for a YouTube search', async () => {
    const page = (title: string, desc: string) =>
      (async () => new Response(`<meta property="og:title" content="${title}"/><meta property="og:description" content="${desc}"/>`, { status: 200 })) as unknown as typeof fetch;
    const sig = AbortSignal.timeout(1000);
    expect(await spotifyItem('https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b', sig, page('Blinding Lights', 'The Weeknd · After Hours · Song · 2020'))).toEqual({
      kind: 'song',
      query: 'Blinding Lights The Weeknd',
    });
    expect(
      await spotifyItem('https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj', sig, page('Listen to After Hours - Album by The Weeknd | Spotify', 'The Weeknd · album · 2020 · 14 songs')),
    ).toEqual({ kind: 'album', query: 'After Hours The Weeknd' });
  });
});
