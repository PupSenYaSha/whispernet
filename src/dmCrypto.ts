import {
  initSessionManager, initPreKeyManager, initializeSignal, getPreKeyBundleForServer,
  createSessionWithRemote, createResponderSession, encryptWithSignal, decryptWithSignal,
  hasSession, resetSession, getSessionId, getMyIdentityKeyBase64, decodeServerBundle,
  serializeX3dhMessage, deserializeX3dhMessage, installSignalFlushHandlers, flushSignalState,
  commitResponderPreKey, releaseResponderPreKey, getPinnedIdentityKey, stopSignalState,
} from './signal/integration';
import { getDeviceId } from './deviceId';
import type { PreKeyBundle } from './signal/types';

/**
 * The ratchet, as the app uses it.
 *
 * One body per device. Signal's shape, and the reason it is this shape: every device has its own
 * identity key, so a sender builds a session with each of a recipient's devices and seals a separate copy
 * for each. Nothing is shared between a phone and a laptop, so compromising one does not open the other,
 * and a message is not routed by asking a server which key to use - there is no shared key to ask about.
 *
 * What that replaced is worth recording, because it was the app's largest weakness: every message used
 * to carry a second copy under a stateless RSA envelope wrapped to a long-lived account key, so that
 * other devices of the sender could read it. Seizing the server opened every message ever sent under
 * that envelope, which quietly made the ratchet's forward secrecy true only for the copy the recipient's
 * device happened to read. Per-device bodies remove the reason the copy existed.
 *
 * The rule that survived the change is the one from the failure that caused it: a session problem
 * degrades to something readable, never to a message nobody can open. What it degrades to now is a
 * message sealed to the devices it can reach, plus a visible notice when none could be - not a silent
 * fallback to a weaker key nobody chose.
 */

/** A ratchet body: the ciphertext, the header it authenticates, and the handshake if it starts one. */
export interface RatchetBody {
  kind: 'ratchet';
  ciphertext: string;
  ratchetPublicKey: string;
  messageNumber: number;
  /** Present only on the very first message to a device: the handshake that starts its session. */
  x3dh?: any;
}

/** The stateless envelope, kept as a floor for a peer that has published no bundle at all. */
export interface EnvelopeBody {
  kind: 'envelope';
  ciphertext: string;
  iv: string;
  encryptedKeys: Record<string, string>;
}

/** A bare body, which is what a single-device conversation sends. */
export type DmBody = RatchetBody | EnvelopeBody;

/** One sealed body per device, which is what reaches a recipient with more than one device. */
export interface DeviceBodies {
  kind: 'devices';
  bodies: { deviceId: string; body: DmBody }[];
}

/** Either shape. A bare body is what an older peer or a one-device conversation sends. */
export type DmPayload = DmBody | DeviceBodies;

export function isDeviceBodies(value: any): value is DeviceBodies {
  return !!value && typeof value === 'object' && value.kind === 'devices' && Array.isArray(value.bodies);
}

let ready = false;
let myId = '';
/** Sessions that could not be built, so the app does not retry on every single message. */
const ratchetUnavailable = new Set<string>();
/** Peers whose published identity key stopped matching the one their session was built on. */
const identityChanged = new Set<string>();

function arrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Whether this peer's identity key has changed since the conversation started. */
export function peerIdentityChanged(peerId: string): boolean {
  return identityChanged.has(peerId);
}

export function clearIdentityChanged(peerId: string): void {
  identityChanged.delete(peerId);
}

export function isDmBody(value: any): value is DmBody {
  return !!value && typeof value === 'object' && typeof value.ciphertext === 'string';
}

/** Brings the key material up for an account, once the password is known. */
export async function startRatchet(userId: string, password: string): Promise<void> {
  // Everything this module remembers about *other people* is dropped first, before the new account's own
  // material is read in. The caches below are keyed by peer id and by device id, and both come from the
  // server, so a second account signing in to the same tab could otherwise inherit the first one's - most
  // sharply in `ownBundles`, which holds this account's own devices, because `sealForDevices` seals an
  // outgoing message to every entry in it. A bundle from the previous account would be sealed to and sent.
  ratchetUnavailable.clear();
  identityChanged.clear();
  forgetBundleForAll();
  ownBundles.length = 0;
  myId = userId;
  await initPreKeyManager(password);
  await initSessionManager(password);
  initializeSignal();
  installSignalFlushHandlers();
  ready = true;
}

export function ratchetReady(): boolean {
  return ready;
}

/** The bundle a stranger needs to open a conversation with us, in the shape the server stores. */
export async function publishBundle(): Promise<any | null> {
  if (!ready) return null;
  try {
    const bundle = await getPreKeyBundleForServer();
    if (!bundle || typeof bundle !== 'object') return null;
    // Stamped with this device's name, because the server now keys bundles on the device and a sender
    // seals a separate body for each one. Without the label the row cannot be routed back.
    return { ...bundle, deviceId: getDeviceId() };
  } catch {
    return null;
  }
}

/**
 * The account-level identity key, which is what a safety number is computed from.
 *
 * Distinct from the per-device bundle keys on purpose: the number has to come out the same on a phone
 * and on a laptop, or comparing it proves nothing. It never leaves the device except as this public
 * half, and the server is careful never to replace it once set - it is the one key here that a
 * conversation can be pinned to for years.
 */
export function accountIdentityKeyBase64(): string | null {
  if (!ready) return null;
  try { return getMyIdentityKeyBase64(); } catch { return null; }
}

/** Every device this account has published, used to seal a copy of each outgoing message to them. */
const ownBundles: { deviceId: string; bundle: PreKeyBundle }[] = [];

export function rememberOwnBundles(raw: any): void {
  ownBundles.length = 0;
  if (!raw || typeof raw !== 'object') return;
  for (const entry of Object.values(raw)) {
    const list = Array.isArray(entry) ? entry : entry ? [entry] : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const deviceId = typeof item.deviceId === 'string' ? item.deviceId : '';
      const decoded = decodeServerBundle(item.bundle);
      if (deviceId && decoded) ownBundles.push({ deviceId, bundle: decoded });
    }
  }
}

/** The peer's bundles, one per device, kept so a send does not have to ask again. */
const preKeyBundles: Record<string, { deviceId: string; bundle: PreKeyBundle }[]> = {};

/** Keeps the bundles the server handed over. */
export function rememberBundles(raw: any): void {
  if (!raw || typeof raw !== 'object') return;
  for (const [id, value] of Object.entries(raw)) {
    const list = Array.isArray(value) ? value : [];
    const decodedList: { deviceId: string; bundle: PreKeyBundle }[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const deviceId = typeof item.deviceId === 'string' ? item.deviceId : '';
      const decoded = decodeServerBundle(item.bundle);
      if (deviceId && decoded) decodedList.push({ deviceId, bundle: decoded });
    }
    if (decodedList.length > 0) preKeyBundles[id] = decodedList;
  }
}

/** A single bundle, as an older server or a single-device account sends it. */
export function rememberBundle(userId: string, bundle: any): void {
  const decoded = decodeServerBundle(bundle);
  if (decoded) preKeyBundles[userId] = [{ deviceId: 'single', bundle: decoded }];
}

/** The peer bundles for one account, empty when nothing has been fetched. */
export function bundlesFor(userId: string): { deviceId: string; bundle: PreKeyBundle }[] {
  return preKeyBundles[userId] || [];
}

export function hasBundlesFor(userId: string): boolean {
  return (preKeyBundles[userId] || []).length > 0;
}

export function forgetBundle(userId: string): void {
  delete preKeyBundles[userId];
  ratchetUnavailable.delete(userId);
}

/**
 * The remote name a session is filed under.
 *
 * A ratchet session belongs to two *devices*. Devices of the same person must not share one: that would
 * put one device's chain keys on the others, and a phone compromise would then open the laptop's
 * messages too. So the remote end of every session is qualified by which device it is - a peer's, or one
 * of this account's own for the copy that keeps a second screen in sync.
 *
 * The separator is a character that cannot appear in a uuid or in a server-issued device id, so
 * `alice/deviceA` and a hypothetical account literally named `alice/deviceA` can never collide into one
 * session.
 */
function remoteNameFor(peerId: string, deviceId: string): string {
  return `${peerId} ${deviceId}`;
}

/** Every session id this device holds for one account, whatever device on the other end it was with. */
function sessionIdsFor(peerId: string): string[] {
  if (!ready || !myId) return [];
  const ids: string[] = [];
  // the device that is talking, which is the one a body is most likely to belong to
  for (const deviceId of [getDeviceId(), ...ownBundles.map((e) => e.deviceId)]) {
    const remote = remoteNameFor(peerId, deviceId);
    if (!ids.includes(remote)) ids.push(remote);
  }
  // and every device of theirs this device has ever been sent something by, which is the set a body can
  // actually belong to once a conversation spans several of their screens
  for (const entry of preKeyBundles[peerId] || []) {
    const remote = remoteNameFor(peerId, entry.deviceId);
    if (!ids.includes(remote)) ids.push(remote);
  }
  return ids;
}

/** Whether this account has a session with one specific device. */
export function sessionExists(peerId: string, peerDeviceId: string): boolean {
  if (!ready || !myId) return false;
  return hasSession(myId, remoteNameFor(peerId, peerDeviceId));
}

/**
 * Seals one message for every device that should receive it.
 *
 * A recipient with two devices gets two bodies, each sealed to that device's own bundle, plus one for
 * each of the sender's own other devices so the conversation is readable there too. The sender's current
 * device is deliberately not given a copy: it already has the plaintext it just typed, and a body it
 * could open would be a body it could be asked to open.
 *
 * A bare body comes back when there is exactly one recipient device, which is the common case and keeps
 * the ordinary single-device conversation byte-for-byte what it always sent.
 */
export async function sealForDevices(
  peerId: string,
  plaintext: string,
  fallback: () => Promise<{ ciphertext: string; iv: string; encryptedKeys: Record<string, string> }>,
): Promise<{ payload: DmPayload; ratchet: boolean; failedDevices: string[] }> {
  const mine = getDeviceId();
  // Every device this message has to reach: the recipient's, and this account's own others so a second
  // screen can read the conversation. The current device is not among them - it has the plaintext.
  const targets: { accountId: string; deviceId: string; bundle: PreKeyBundle }[] = [];

  for (const entry of bundlesFor(peerId)) {
    targets.push({ accountId: peerId, deviceId: entry.deviceId, bundle: entry.bundle });
  }
  for (const entry of ownBundles) {
    if (entry.deviceId === mine) continue;
    targets.push({ accountId: myId, deviceId: entry.deviceId, bundle: entry.bundle });
  }

  if (!ready || !myId || targets.length === 0 || ratchetUnavailable.has(peerId)) {
    return { payload: { kind: 'envelope', ...(await fallback()) }, ratchet: false, failedDevices: [] };
  }

  const bodies: { deviceId: string; body: DmBody }[] = [];
  const failedDevices: string[] = [];
  // How many of the sealed bodies are for the *peer*. The recipient's own other screens are targets here
  // too, so `bodies.length > 0` does not mean the message can reach the person it was written to.
  let forPeer = 0;
  for (const target of targets) {
    try {
      bodies.push({
        deviceId: target.deviceId,
        body: await sealForDevice(target.accountId, target.deviceId, target.bundle, plaintext),
      });
      if (target.accountId === peerId) forPeer++;
    } catch (e) {
      console.warn(`[ratchet] no body for device ${target.deviceId}:`, (e as Error).message);
      failedDevices.push(target.deviceId);
    }
  }

  if (bodies.length === 0) {
    // Nothing could be sealed, and an empty fan-out would be a message delivered to nobody. Rather than
    // drop it, fall back to the one shape that needs no prekey - and say so, because a fallback that
    // arrives without being announced is exactly the failure mode this replaced.
    ratchetUnavailable.add(peerId);
    return { payload: { kind: 'envelope', ...(await fallback()) }, ratchet: false, failedDevices };
  }

  // Same, for the case that is not obvious: the peer's bundles were empty - they are offline, or the
  // prekey fetch timed out - while this account happens to have a second device signed in. The loop above
  // sealed a body for that second device and nothing else, and the `bodies.length === 1` line below turned
  // it into a *bare* body addressed to the sender's own laptop. The recipient could not open it, and
  // `failedDevices` was empty, so the caller reported a clean delivery and the message simply never
  // arrived. The peer's absence has to be an absence, not a quiet success.
  if (forPeer === 0) {
    ratchetUnavailable.add(peerId);
    return { payload: { kind: 'envelope', ...(await fallback()) }, ratchet: false, failedDevices };
  }

  if (bodies.length === 1) return { payload: bodies[0].body, ratchet: true, failedDevices };
  return { payload: { kind: 'devices', bodies }, ratchet: true, failedDevices };
}

/** One body, sealed to one device's bundle. */
async function sealForDevice(
  accountId: string,
  peerDeviceId: string,
  bundle: PreKeyBundle,
  plaintext: string,
): Promise<RatchetBody> {
  const remote = remoteNameFor(accountId, peerDeviceId);
  const sessionId = getSessionId(myId, remote);

  // A different identity key than the session was pinned to means that device reinstalled, or the server
  // handed out a key nobody asked for. Either way the old session is finished: nothing the device still
// holds will open under it, so it goes now and this message starts a fresh handshake.
   //
   // The safety number deliberately does not move with it: it comes from the account-level key, which is
   // identical on every device and survives one of them being reinstalled. What has changed here is a
   // device rather than a person, and a replaced device is not something two people compare a number about.
  if (hasSession(myId, remote)) {
    const pinned = getPinnedIdentityKey(sessionId);
    if (pinned && bundle.identityKey.length && arrayToBase64(pinned) !== arrayToBase64(bundle.identityKey)) {
      resetSession(myId, remote);
      identityChanged.add(accountId);
    }
  }

  // Creating an initiator session over one that already exists would restart the chain from the handshake
  // while the far end keeps its place in the old one, and every message after that would fail to
  // authenticate for no visible reason. This was found by a test that sent two messages to the same
  // device, which is what a conversation does constantly, so it is pinned rather than assumed away.
  let startedSession: any = null;
  if (!hasSession(myId, remote)) {
    const started = createSessionWithRemote(myId, remote, bundle);
    if (!started) throw new Error('could not start a session');
    startedSession = started;
  }
  const sealed = await encryptWithSignal(sessionId, plaintext);
  const body: RatchetBody = {
    kind: 'ratchet',
    ciphertext: sealed.ciphertext,
    ratchetPublicKey: sealed.ratchetPublicKey,
    messageNumber: sealed.messageNumber,
  };
  if (startedSession) body.x3dh = serializeX3dhMessage(startedSession.x3dhMessage);
  return body;
}

/**
 * Opens whatever the server delivered for this conversation.
 *
 * The server routes by device, so the usual case is already just this device's body. A fan-out that
 * arrives whole - history from before routing, or a message stored when several devices were signed in
 * - is searched for the body belonging to this device, and only that one is tried.
 *
 * A body that will not open reports the failure rather than inventing text, and resets the session so
 * the next message starts a fresh conversation instead of failing the same way forever.
 */
export async function openFor(
  peerId: string,
  payload: DmPayload | null | undefined,
  privateKeyJwk?: JsonWebKey | null,
): Promise<string | null> {
  if (!payload) return null;
  if (!isDeviceBodies(payload)) return await openOne(peerId, payload, privateKeyJwk);
  const mine = getDeviceId();
  const forMe = payload.bodies.find((entry) => entry.deviceId === mine);
  if (!forMe) return null;
  return await openOne(peerId, forMe.body, privateKeyJwk);
}

/** One body, from one device. */
async function openOne(
  peerId: string,
  body: DmBody,
  privateKeyJwk?: JsonWebKey | null,
): Promise<string | null> {
  if (body.kind === 'ratchet') {
    if (ready && myId) {
      // The session is filed under this sender's account and whatever device they sent from, which the
      // body does not say. Each candidate is tried, and exactly one of them can possibly open: a session
      // is pinned to the identity key that was used to build it, so a body sealed for another device
      // fails the check rather than being opened by the wrong session.
      // The sessions this call actually built, as opposed to the ones it merely tried.
      //
      // Resetting the whole candidate list here used to be the obvious thing to do, and it was wrong.
      // `candidateRemotes` is every session this device holds with that person *plus* every session it
      // holds with its own other devices - so a body that no candidate could open wiped all of them. The
      // commonest such body is one that was never meant for this device at all: `sealForDevices`
      // deliberately gives the *sending* device no copy of its own message, so every own-message echo is a
      // bare body its author provably cannot open, and the server sends it back. With `App.tsx` reading
      // every frame it is handed, that meant each message a user sent tore down their own session with that
      // peer - discarding the out-of-order key windows and forcing a fresh handshake, and burning a
      // one-time prekey, on the next send.
      //
      // Worse on a history page, where the messages are opened with `Promise.all`: those resets run
      // outside the per-session decrypt lock and delete the session while other decrypts are still using
      // it. Those messages decrypt, and then the ones after them in the same page cannot.
      //
      // A session this call created from a handshake that then failed is genuinely worthless and has to go.
      // A session that existed beforehand is not evidence of anything except that it is not this body's.
      const created = new Set<string>();
      for (const remote of candidateRemotes(peerId)) {
        try {
          if (body.x3dh && !hasSession(myId, remote)) {
            const x3dh = deserializeX3dhMessage(body.x3dh);
            if (x3dh) {
              createResponderSession(myId, remote, x3dh, base64ToBytes(body.ratchetPublicKey));
              created.add(remote);
            }
          }
          const sessionId = getSessionId(myId, remote);
          const opened = await decryptWithSignal(sessionId, body.ciphertext, body.ratchetPublicKey, body.messageNumber);
          // Named by conversation: a borrow belongs to the session that made it, so a handshake in flight
          // with somebody else cannot spend this one's prekey.
          commitResponderPreKey(sessionId);
          return opened;
        } catch {
          // the borrowed one-time prekey goes back rather than being spent on a handshake nobody proved
          releaseResponderPreKey(getSessionId(myId, remote));
        }
      }
      // Nothing opened it. Only the sessions built here are cleared - see above for what the wider version
      // used to cost.
      for (const remote of created) resetSession(myId, remote);
      ratchetUnavailable.delete(peerId);
    }
    return null;
  }
  return await openEnvelope(body, privateKeyJwk);
}

/**
 * Which devices a body could belong to.
 *
 * A message does not name the device it was sealed for — that is the server's business, and it strips
 * the label when it routes. So the recipient has to try the sessions it holds for that person: every
 * device of theirs this device has a session with, plus every device of *this* account, because a sender
 * also seals a copy to the recipient's own other screens.
 *
 * This list used to be only the talking device and this account's others, which was a real bug: on the
 * *sender's* side the session is filed under the recipient's device, so a sender with two devices could
 * not read back what it had just written on its second screen. A wrong guess costs one decryption
 * attempt and fails the identity check; there is no way for it to return the wrong plaintext.
 */
function candidateRemotes(peerId: string): string[] {
  const remotes = sessionIdsFor(peerId);
  if (myId) {
    for (const entry of ownBundles) {
      const remote = remoteNameFor(myId, entry.deviceId);
      if (!remotes.includes(remote)) remotes.push(remote);
    }
  }
  return remotes;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function openEnvelope(
  body: { ciphertext: string; iv: string; encryptedKeys: Record<string, string> },
  privateKeyJwk?: JsonWebKey | null,
): Promise<string | null> {
  if (!myId || !privateKeyJwk) return null;
  try {
    const { decryptMessage } = await import('./crypto');
    return await decryptMessage(body, myId, privateKeyJwk);
  } catch {
    return null;
  }
}

export function myIdentityKeyBase64(): string | null {
  if (!ready) return null;
  try { return getMyIdentityKeyBase64(); } catch { return null; }
}

/**
 * The identity key this device has pinned for a peer, or null when it has none.
 *
 * From the session rather than from a profile the server can rewrite, so a checkmark drawn next to a
 * contact refers to the key actually in use for the conversation. Null when there is no session, which
 * is the honest answer: with no key exchanged there is nothing to have verified.
 */
export function peerDeviceIdentityKeyBase64(peerId: string): string | null {
  if (!ready || !myId) return null;
  const pinned = getPinnedIdentityKey(getSessionId(myId, remoteNameFor(peerId, getDeviceId())));
  if (!pinned || pinned.length === 0) return null;
  let binary = '';
  for (const byte of pinned) binary += String.fromCharCode(byte);
  try {
    return btoa(binary);
  } catch {
    return null;
  }
}

/**
 * The number two people read aloud to confirm they are talking to each other.
 *
 * Derived from the long-lived identity keys, so a server that quietly handed each of them a different
 * key produces a different number on each side - which is the entire point of showing it. Null while
 * either side has not published a key yet, because a number derived from one key alone could never match
 * anything and would only ever look like an attack.
 */
export async function safetyNumber(peerIdentityKeyB64?: string | null): Promise<string | null> {
  const mine = myIdentityKeyBase64();
  if (!mine) return null;
  const { generateSafetyNumber } = await import('./crypto');
  return generateSafetyNumber(mine, peerIdentityKeyB64);
}

/**
 * Throws away every key and session this device holds and starts over.
 *
 * The recovery tool for the case a reinstall or a wiped browser creates: the identity key that other
 * people's conversations were pinned to is gone, so nothing sent before can ever be read here again, and
 * every session with it. What it does not do is quietly produce a working-looking app that has lost
 * people's history - the caller reloads, and the account's own backup, which still holds the old key, is
 * what restores anything.
 *
 * Refuses to run before the ratchet has ever been unlocked, which is the only point at which there is
 * nothing to lose anyway.
 */
export function resetEncryptionIdentity(): boolean {
  if (!ready) return false;
  // Before anything is deleted, not after. The flush handlers this function's own `startRatchet` installed
  // fire on `pagehide`, which is the very next thing the caller does; they cancel the debounce and write the
  // state straight back out with the key still in hand, so the identity key and every chain key went back
  // into localStorage milliseconds after being removed. Whether that race was won was down to the browser.
  // Taking the managers offline first makes the deletion the last word.
  stopSignalState();
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('wn_signal_') || key === 'wn_own_dm_text' || key === 'wn_own_dm_text__salt') {
      try { localStorage.removeItem(key); } catch { /* private mode */ }
    }
  }
  // the drafts box is sealed under the account password and is destroyed with everything else here: both
  // of these are per-account material and there is nothing in this path that preserves them
  for (const key of ['wn_drafts', 'wn_drafts__salt']) {
    try { localStorage.removeItem(key); } catch { /* as above */ }
  }
  ratchetUnavailable.clear();
  identityChanged.clear();
  forgetBundleForAll();
  ownBundles.length = 0;
  myId = '';
  ready = false;
  return true;
}

function forgetBundleForAll(): void {
  for (const key of Object.keys(preKeyBundles)) delete preKeyBundles[key];
}

export function flushRatchet(): void {
  flushSignalState();
}

export { getSessionId };