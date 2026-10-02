import { describe, it, expect } from 'vitest';
import { parseMediaTag, isMediaMessage, buildMediaTag } from '../../src/media-crypto';

/**
 * A media message carries its url inside a `[image]...[/image]` marker. Five copies of that regex
 * used to live in the codebase, two of which disagreed about the capture groups: the reader asked
 * for group 2 of a regex that only had one, so every attachment was fetched as
 * `/api/media?url=undefined` and reported "Could not decrypt attachment".
 */
describe('media tag', () => {
  it('reads back the url it wrote', () => {
    const url = 'https://img.example/abc123.bin';
    const parsed = parseMediaTag(buildMediaTag('image', url));
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('image');
    expect(parsed!.url).toBe(url);
  });

  it('never hands back undefined', () => {
    const parsed = parseMediaTag('[video]https://h/v.mp4[/video]');
    expect(parsed!.url).toBe('https://h/v.mp4');
    expect(parsed!.url).not.toBeUndefined();
  });

  it('tells the kinds apart', () => {
    expect(parseMediaTag('[image]u[/image]')!.kind).toBe('image');
    expect(parseMediaTag('[video]u[/video]')!.kind).toBe('video');
  });

  it('does not match a mismatched closing tag', () => {
    expect(parseMediaTag('[image]u[/video]')).toBeNull();
  });

  it('leaves ordinary text alone', () => {
    for (const text of ['', 'hello', '[image]unclosed', '[/image]', '[photo]u[/photo]', '[image][/image]']) {
      expect(parseMediaTag(text), text).toBeNull();
      expect(isMediaMessage(text), text).toBe(false);
    }
  });

  it('survives null and undefined', () => {
    expect(parseMediaTag(null)).toBeNull();
    expect(parseMediaTag(undefined)).toBeNull();
    expect(isMediaMessage(null)).toBe(false);
  });

  it('keeps a url that itself contains brackets or slashes', () => {
    const url = 'https://h/a/b?x=1&y=[2]';
    expect(parseMediaTag(buildMediaTag('image', url))!.url).toBe(url);
  });

  it('round trips through build and parse for both kinds', () => {
    for (const kind of ['image', 'video'] as const) {
      const url = `https://h/${kind}.bin`;
      expect(buildMediaTag(kind, url)).toBe(`[${kind}]${url}[/${kind}]`);
      expect(parseMediaTag(buildMediaTag(kind, url))).toEqual({ kind, url });
    }
  });
});
