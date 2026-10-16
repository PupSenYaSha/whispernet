import { searchSolution } from './registerPow';

/**
 * The registration search, off the main thread.
 *
 * At the difficulty the server asks for this runs for seconds. On the main thread that is seconds of a
 * frozen tab: no typing, no scrolling, no repaint, and to anyone watching it the app has hung rather than
 * doing something. Here it is a worker, so the interface stays live and can show honest progress and offer a
 * way out.
 *
 * The work is a pure function of the two values the server sent, so there is nothing to keep and no state to
 * lose if the tab is backgrounded - the answer is the same either way.
 */

export interface PowRequest {
  challenge: string;
  bits: number;
}

export type PowResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; nonce: number }
  | { type: 'cancelled' }
  | { type: 'failed'; reason: string };

let stop = false;

self.onmessage = (e: MessageEvent<PowRequest | { type: 'cancel' }>) => {
  const msg = e.data;
  if ((msg as { type?: string }).type === 'cancel') { stop = true; return; }
  const req = msg as PowRequest;
  try {
    const nonce = searchSolution(
      req.challenge,
      req.bits,
      (fraction) => { (self as unknown as Worker).postMessage({ type: 'progress', fraction } satisfies PowResponse); },
      () => stop,
    );
    if (nonce === null) {
      (self as unknown as Worker).postMessage({ type: 'cancelled' } satisfies PowResponse);
      return;
    }
    (self as unknown as Worker).postMessage({ type: 'done', nonce } satisfies PowResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'failed',
      reason: err instanceof Error ? err.message : 'search failed',
    } satisfies PowResponse);
  } finally {
    stop = false;
  }
};
