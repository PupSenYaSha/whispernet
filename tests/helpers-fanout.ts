import { generateIdentityKeyPair, generateSignedPreKeyRecord, generateKeyPair } from '../src/signal/keys';

/**
 * Builds the encrypted bodies a sender produces, without a websocket or an account around them.
 *
 * The app's own `sealForDevices` is bound to a live signed-in account: it reads the bundles it fetched
 * over the socket and publishes under the device id the server gave this connection. That is right for the
 * app and wrong for a test, because what is worth checking here is the *shape* of what goes on the wire
 * and whether the server routes it correctly - and that can be exercised with plain managers.
 *
 * So this mirrors the app's construction deliberately and only deliberately: one initiator session per
 * recipient device, the remote side of each qualified by which device it is, the handshake attached to
 * the body that starts it. If the app's version diverges, this file is where the difference has to be
 * reconciled, which is the point of writing it out rather than importing it.
 *
 * The managers keep their state in `localStorage`, which does not exist outside a browser, so a fake one
 * is installed here rather than in every test file. It has to happen before the session module is
 * imported - a module that captured the real one at import time would be holding `undefined` - which is
 * why that import is dynamic and sits below.
 */

const store = new Map<string, string>();
if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
}

const { SessionManager } = await import('../src/signal/session');
const { serializeX3dhMessage, deserializeX3dhMessage, decodeServerBundle } = await import('../src/signal/integration');

const PASSWORD = 'pass123456';

export interface TestDevice {
  /** The account-level identity key, shared by every device of one person. */
  accountKey: string;
  /** This device's ratchet identity, which is its own. */
  deviceIdentity: ReturnType<typeof generateIdentityKeyPair>;
  signedPreKey: ReturnType<typeof generateSignedPreKeyRecord>;
  manager: InstanceType<typeof SessionManager>;
  deviceId: string;
  /**
   * The one-time prekey this device last published, kept because answering a handshake needs the same
   * private half the sender encrypted to. X3DH is one-way in the prekey: the sender used the public half
   * it fetched, and only this device can finish the exchange. A test that generated the prekey and threw
   * it away would be testing a device nobody can talk to.
   */
  lastPublishedPreKey: { publicKey: Uint8Array; privateKey: Uint8Array } | null;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function unb64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/** A bundle in the shape the server stores and hands back. */
export function bundleFor(device: TestDevice, oneTime?: { publicKey: Uint8Array }): any {
  return {
    bundleVersion: 2,
    registrationId: device.deviceIdentity.registrationId,
    identityKey: b64(device.deviceIdentity.publicKey),
    ed25519PublicKey: b64(device.deviceIdentity.ed25519PublicKey),
    signedPreKey: {
      keyId: device.signedPreKey.keyId,
      publicKey: b64(device.signedPreKey.keyPair.publicKey),
      signature: Array.from(device.signedPreKey.signature),
      createdAt: device.signedPreKey.createdAt,
    },
    ...(oneTime ? { oneTimePreKey: { keyId: 1, publicKey: b64(oneTime.publicKey) } } : {}),
  };
}

/** A fresh device: its own ratchet identity, its own signed prekey, its own session manager. */
export async function makeDevice(deviceId: string, accountKey?: string): Promise<TestDevice> {
  const deviceIdentity = generateIdentityKeyPair();
  const signedPreKey = generateSignedPreKeyRecord(deviceIdentity.ed25519PrivateKey, 1);
  const manager = new SessionManager();
  liveManagers.push(manager);
  await manager.init(PASSWORD);
  return {
    accountKey: accountKey || `acct-${deviceId}`,
    deviceIdentity,
    signedPreKey,
    manager,
    deviceId,
    lastPublishedPreKey: null,
  };
}

/** The bundle a device publishes, with a fresh one-time prekey recorded against the device. */
export function publish(device: TestDevice): any {
  const preKey = generateKeyPair();
  device.lastPublishedPreKey = preKey;
  return bundleFor(device, preKey);
}

/**
 * Seals one plaintext for each of several devices, the way the app builds a fan-out.
 *
 * The remote name of every session is qualified by device, which is the whole point: two devices of one
 * person must not share a session, or taking one of them would open the other's traffic.
 */
export async function sealToEach(
  sender: TestDevice,
  senderAccountId: string,
  targets: { deviceId: string; bundle: any }[],
  plaintext: string,
): Promise<{ deviceId: string; body: any }[]> {
  const out: { deviceId: string; body: any }[] = [];
  for (const target of targets) {
    const remote = `${senderAccountId} ${target.deviceId}`;
    // what the server hands back is JSON, and the signature in particular arrives as an array of numbers
    // rather than as bytes - decoded through the same path the app uses so this test cannot accidentally
    // be the more permissive one
    const bundle = decodeServerBundle(target.bundle);
    if (!bundle) throw new Error(`unusable bundle for device ${target.deviceId}`);

    // Reuse the session if there already is one. Creating a fresh initiator session over an existing one
    // restarts the chain from the handshake, which is not what a second message does — the two sides then
    // disagree about the chain and the body fails to authenticate with no obvious reason why. This is the
    // same condition the app checks before starting a session.
    const sessionId = sender.manager.getSessionId(senderAccountId, remote);
    const existing = sender.manager.getSession(sessionId);
    const started = existing
      ? { x3dhMessage: null as any, ratchetPublicKey: existing.state.currentRatchetPublicKey! }
      : sender.manager.createInitiatorSession(
          senderAccountId,
          remote,
          { privateKey: sender.deviceIdentity.privateKey, publicKey: sender.deviceIdentity.publicKey },
          bundle,
        );

    const ratchetPublicKey = started.ratchetPublicKey;
    const x3dhMessage = started.x3dhMessage;
    const sealed = await sender.manager.encryptMessage(sessionId, plaintext);
    // the number that goes on the wire is one less than the counter, which has already moved by the time
    // encryptMessage returns - the same adjustment the app makes when it reads the counter back
    out.push({
      deviceId: target.deviceId,
      body: {
        kind: 'ratchet',
        ciphertext: b64(sealed),
        ratchetPublicKey: b64(ratchetPublicKey),
        messageNumber: sender.manager.getSession(sessionId)!.state.sendingMessageNumber - 1,
        // the handshake rides with the body that starts the session, in the same serialised form the app
        // puts on the wire - arrays rather than base64, because that is what the JSON body carries
        x3dh: serializeX3dhMessage(x3dhMessage),
      },
    });
  }
  return out;
}

/**
 * The other end: answers the handshake and reads the message, as the receiving device would.
 *
 * The remote name is the *sender's* account and *this* device's id — the asymmetry that matters and is
 * easy to get backwards. A session is filed under the pair (who sent, which of my devices), so a sender
 * creates it as `<their account> <recipient device>` and the recipient looks it up under exactly that
 * string. Writing `<their account> <sender device>` here answers a handshake in a session nobody will
 * ever look in, and every read then fails with no clue why.
 *
 * `expectFailure` is for the case a body is deliberately the wrong one - a test that expects a body
 * *not* to open should say so, rather than leaving a warning in the output that reads like a real
 * problem and trains the eye to skip past it.
 */
export async function openAsRecipient(
  recipient: TestDevice,
  recipientAccountId: string,
  senderAccountId: string,
  body: any,
  expectFailure = false,
): Promise<string | null> {
  const remote = `${senderAccountId} ${recipient.deviceId}`;
  const x3dh = body?.x3dh ? deserializeX3dhMessage(body.x3dh) : null;
  if (x3dh && !recipient.manager.getSession(recipient.manager.getSessionId(recipientAccountId, remote))) {
    recipient.manager.createResponderSessionFromMessage(
      recipientAccountId,
      remote,
      { privateKey: recipient.deviceIdentity.privateKey, publicKey: recipient.deviceIdentity.publicKey },
      recipient.signedPreKey.keyPair,
      // the private half of the prekey this device published, which is what makes the handshake
      // finishable - the sender only ever saw the public half
      recipient.lastPublishedPreKey,
      x3dh,
      unb64(body.ratchetPublicKey),
      new Uint8Array(0),
      0,
    );
  }
  const sessionId = recipient.manager.getSessionId(recipientAccountId, remote);
  try {
    // the manager takes the message number before the ratchet key, which is the reverse of the order
    // they travel in on the wire - the integration wrapper exists precisely to hide that
    // the manager returns the text itself, not bytes
    return await recipient.manager.decryptMessage(
      sessionId,
      unb64(body.ciphertext),
      body.messageNumber,
      unb64(body.ratchetPublicKey),
    );
  } catch (e) {
    // "would not open" is the same symptom for a wrong remote name, a stale handshake and a tampered
    // header, so the reason is worth seeing - unless the test is asking for exactly this
    if (!expectFailure) {
      console.warn(`[fanout] ${recipient.deviceId} could not open the body:`, (e as Error).message);
    }
    return null;
  }
}

/**
 * Every manager this file has handed out, so a test can tear them down.
 *
 * Not tidiness. The managers share one `localStorage` key, and their saves are debounced timers, so a
 * manager left over from an earlier test writes its sessions out partway through a later one - under the
 * state it held then. The symptom is a test that passes alone and fails in a run, which is a green that
 * means nothing. Same reason `SessionManager` grew a `destroy()`; the prekey manager always had one.
 */
const liveManagers: InstanceType<typeof SessionManager>[] = [];

/** Drops every manager, so no pending write lands in the next test. Call from `afterEach`. */
export function resetFanoutDevices(): void {
  for (const m of liveManagers.splice(0)) m.destroy();
}

export { PASSWORD };