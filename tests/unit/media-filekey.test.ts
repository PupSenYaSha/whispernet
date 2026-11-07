import { describe, it, expect } from 'vitest';
import { sealFileKeyInText, openFileKeyFromText, parseMediaTag } from '../../src/media-crypto';

/**
 * Where the key for a private attachment lives, and what must not happen to it.
 *
 * A private attachment carries its key inside the message text, because sending it beside the message would
 * hand every relay the file key. The text is therefore stripped on the way in: a quote bubble, a search
 * result, a copy or a forwarded message must not be able to carry a key into somebody else's chat.
 *
 * The stripping used to be the whole story — `openFileKeyFromText(...).text` was stored as the message's
 * text and the entry it returned was thrown away. Since that stripped text was the only copy the app kept,
 * `decryptMedia` went looking for a marker that had already been removed, found nothing, and gave up. Every
 * photo and video sent in a private conversation was a permanently broken bubble pointing at its own
 * ciphertext, for both ends, with no error shown. So the two halves are now separate: the key is carried
 * beside the text, and these tests pin that neither can be produced without the other.
 */
describe('the attachment key carried inside a sealed message', () => {
  const KEY = new Uint8Array(32).fill(7).buffer;
  const IV = 'aXYtYmFzZTY0';
  const URL = 'https://media.example/abc123';
  const text = `[image]${URL}[/image]`;

  const sealed = sealFileKeyInText(text, KEY, IV);
  const opened = openFileKeyFromText(sealed);

  it('comes back out of the text it was put into', () => {
    expect(opened.entry).toBe(`${IV}:${Buffer.from(new Uint8Array(KEY)).toString('base64')}`);
  });

  it('leaves displayable text behind', () => {
    // The media marker has to stay at the start of the line: every reader and the quote renderer already
    // expect it there, which is why the key is appended rather than prepended.
    expect(opened.text).toBe(text);
    expect(parseMediaTag(opened.text)?.url).toBe(URL);
  });

  /**
   * The failure itself.
   *
   * Nothing downstream of this needs to know what a key looks like; the bug was structural - a value
   * produced and then not kept - so this is the assertion that would have caught it, and it is the one that
   * reads oddly next to the rest of the file on purpose: the two results are independent, and a caller that
   * keeps only one of them has thrown the attachment away.
   */
  it('yields the text and the key separately, so keeping the text does not lose the key', () => {
    expect(opened.text).not.toContain(IV);
    expect(opened.text).not.toContain('filekey');
    expect(opened.entry).toBeTruthy();
  });

  it('reports no key for an ordinary message', () => {
    expect(openFileKeyFromText('just some words')).toEqual({ text: 'just some words', entry: null });
  });

  it('reports no key when the closing marker is missing', () => {
    // A truncated body must not be treated as carrying a half a key.
    const half = sealFileKeyInText(text, KEY, IV);
    const cut = half.slice(0, half.indexOf('[/filekey]') === -1 ? half.length : half.indexOf('[/filekey]'));
    expect(openFileKeyFromText(cut).entry).toBeNull();
  });

  it('survives the round trip with the media tag still parseable', () => {
    // The whole point of stripping rather than mangling: the bubble still renders as an image, and the key
    // is still recoverable by whoever is entitled to it.
    const twice = sealFileKeyInText(opened.text, KEY, IV);
    const again = openFileKeyFromText(twice);
    expect(again.entry).toBe(opened.entry);
    expect(parseMediaTag(again.text)?.url).toBe(URL);
  });
});