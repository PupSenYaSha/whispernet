/**
 * The decrypted media cache: what the app is holding in memory because somebody might be looking at it.
 *
 * Decrypting an attachment is expensive and slow, so the result is kept. The subtlety is that keeping
 * media means keeping plaintext bytes — the whole file, decrypted, because a Blob is handed to the browser
 * and the browser draws it.
 *
 * That makes the ceiling a memory question rather than a bookkeeping one, and the ceiling used to be a
 * count: a hundred entries. An attachment is allowed to be a gigabyte, so a hundred of them is a hundred
 * gigabytes of plaintext, and a phone has never had that to give. Counting entries silently assumed the
 * files were the size of an avatar, which is the one thing about them that was never true. There is now a
 * byte budget beside the count, and the count is only ever the smaller half of the answer.
 *
 * Object URLs are reference counted by the bubbles showing them. Dropping the oldest entry
 * unconditionally blanked an image that was still on screen the moment the hundred-and-first media message
 * arrived, which is the other way this goes wrong: a cache that frees memory by breaking what the user is
 * looking at has not saved anything. So entries on screen are untouchable, and the byte budget is a
 * target the cache tries to get back under rather than a line it is always allowed to cross.
 */

export const ENTRY_LIMIT = 100;
export const BYTE_BUDGET = 256 * 1024 * 1024;

export class MediaCache {
  private urls = new Map<string, string>();
  private sizes = new Map<string, number>();
  private refs = new Map<string, number>();
  /** Entries whose provisional claim a bubble has already taken over. */
  private adopted = new Set<string>();
  private total = 0;

  bytes(): number {
    return this.total;
  }

  tracked(): number {
    return this.refs.size;
  }

  has(id: string): boolean {
    return this.urls.has(id);
  }

  urlFor(id: string): string | undefined {
    return this.urls.get(id);
  }

  /**
   * Takes ownership of an object URL, evicting what it can to stay inside both ceilings.
   *
   * The entry starts out claimed. Decryption is slow and React's effect that marks a bubble as showing it
   * only runs after this returns and the component has re-rendered — and a chat full of media decrypts in
   * a burst, so several `put`s land in the window before any of those effects run. Without a claim made
   * here, the byte budget could revoke a url in exactly that gap, the bubble would then retain a url that
   * no longer resolves, and the image would be blank for the rest of the message's life with nothing in
   * the console to say why.
   */
  put(id: string, url: string, size: number): void {
    this.urls.set(id, url);
    this.sizes.set(id, size);
    this.total += size;
    this.refs.set(id, 1);
    this.adopted.delete(id);
    this.evict();
  }

  /**
   * A bubble is now showing this. Takes over the claim `put` made rather than adding to it, so the common
   * case of one bubble per message ends up at one reference, not two — which is what lets a single
   * `release` on unmount actually free it.
   */
  retain(id: string): void {
    if (this.refs.has(id) && !this.adopted.has(id)) {
      this.adopted.add(id);
      return;
    }
    this.refs.set(id, (this.refs.get(id) ?? 0) + 1);
  }

  release(id: string): void {
    const held = this.refs.get(id);
    if (held === undefined) return;
    // removed rather than left at zero, so the refcount map cannot grow one entry per media message for
    // the life of the tab. `evict` reads a missing id as zero anyway, so to every reader the two are the
    // same thing.
    if (held <= 1) {
      this.refs.delete(id);
      this.adopted.delete(id);
      // the bubble that was holding these bytes has gone, so this is the moment the budget can actually be
      // met. Without it the cache sat above the line until the next decryption happened to come along,
      // which on a quiet screen is never.
      this.evict();
    } else {
      this.refs.set(id, held - 1);
    }
  }

  private evict(): void {
    for (const [id, url] of this.urls) {
      if (this.urls.size <= ENTRY_LIMIT && this.total <= BYTE_BUDGET) return;
      if ((this.refs.get(id) ?? 0) > 0) continue;
      this.urls.delete(id);
      this.total -= this.sizes.get(id) ?? 0;
      this.sizes.delete(id);
      try { URL.revokeObjectURL(url); } catch { /* already gone */ }
    }
  }

  /** Revokes everything, for signing out. */
  clear(): void {
    for (const url of this.urls.values()) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
    this.urls.clear();
    this.sizes.clear();
    this.refs.clear();
    this.adopted.clear();
    this.total = 0;
  }
}