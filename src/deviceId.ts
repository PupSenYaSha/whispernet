/**
 * This browser's own name, as far as a peer's key material is concerned.
 *
 * Signal gives every device its own identity key, so a sender can seal a separate message for each
 * screen an account is signed in on. That only works if a device can be named consistently: the name a
 * bundle is published under, the name a message body is labelled with, and the name the server routes
 * on have to be the same string, or the message arrives at a device that cannot open it.
 *
 * Kept in its own module because it is now referenced from the crypto layer as well as the app shell,
 * and the crypto layer has no business reaching into a React component's closures.
 *
 * The value never leaves the device in any meaningful sense - the server has to know it to route, and it
 * learns nothing by it that it does not already know from a session row.
 */
const DEVICE_ID_KEY = 'wn_device_id';

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (crypto as any).randomUUID ? crypto.randomUUID() : 'dev-' + Math.random().toString(36).slice(2);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // storage unavailable: a fixed name still routes, it just cannot distinguish two devices in one
    // browser profile, which is the situation that produces this in the first place
    return 'device';
  }
}

/**
 * Records the id the server settled on, so the next launch presents the same one.
 *
 * A fresh install is given an id by the server, and using the local one afterwards would mean the
 * device registers a second session on every launch until the cap stops it - which reads to the user
 * as being locked out of their own account after a few restarts.
 */
export function adoptServerDeviceId(serverDeviceId: unknown): void {
  if (typeof serverDeviceId !== 'string' || !serverDeviceId || serverDeviceId.length > 128) return;
  try {
    if (localStorage.getItem(DEVICE_ID_KEY) !== serverDeviceId) localStorage.setItem(DEVICE_ID_KEY, serverDeviceId);
  } catch { /* nothing to record it in */ }
}