import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeDevice, publish, sealToEach, resetFanoutDevices, PASSWORD } from '../helpers-fanout';

/**
 * A body this device was never sent must not cost it the conversation it already had.
 *
 * `openOne` tries every session it holds for a sender, because a body does not name the device it was
 * sealed for - the server strips that label when it routes. When none of them opens the body, the old
 * code cleared *all* of them.
 *
 * That is far wider than the failure it was written for. A session built by a handshake that then failed
 * to decrypt anything is worthless and has to go; a session that existed beforehand is not evidence of
 * anything except that this particular body was not its. And the commonest body no session can open is
 * one that was never meant for this device: `sealForDevices` deliberately gives the *sending* device no
 * copy of its own message, and the server echoes it back. So the old behaviour was that every message you
 * sent tore down your own session with that person - discarding the out-of-order key windows, discarding
 * anything that had arrived out of order, and forcing a fresh handshake that spends a one-time prekey on
 * the next send.
 *
 * The helper is imported first and the crypto layer second: the session store needs a `localStorage`, and
 * `helpers-fanout` is what installs one before it pulls the store in.
 */
const dmCrypto = await import('../../src/dmCrypto');

const ME = 'me-account';
const PEER = 'peer-account';
const MY_DEVICE = 'my-phone';
const PEER_DEVICE = 'peer-phone';

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

describe('a body that no session here can open', () => {
  beforeEach(() => {
    localStorage.clear();
    // fixed, so the candidate list is the same on every run
    localStorage.setItem('wn_device_id', MY_DEVICE);
  });

  afterEach(() => {
    resetFanoutDevices();
  });

  it('leaves the live session with that sender in place', async () => {
    await dmCrypto.startRatchet(ME, PASSWORD);
    expect(dmCrypto.ratchetReady()).toBe(true);

    // this device's own published bundle, which is what a sender seals against. Publishing is also what
    // puts the signed prekey and the one-time prekeys into the prekey manager, so it has to happen before
    // anything tries to answer a handshake.
    const myBundle = await dmCrypto.publishBundle();
    expect(myBundle).toBeTruthy();
    expect(myBundle.deviceId).toBe(MY_DEVICE);

    // the sender, and the bundle it hands out in turn
    const peer = await makeDevice(PEER_DEVICE, PEER);
    const peerBundle = publish(peer);
    dmCrypto.rememberBundles({ [PEER]: [{ deviceId: PEER_DEVICE, bundle: peerBundle }] });

    // a real message, so there is a real session to lose
    const bodies = await sealToEach(peer, PEER, [{ deviceId: MY_DEVICE, bundle: myBundle }], 'hello there');
    expect(await dmCrypto.openFor(PEER, bodies[0].body, null)).toBe('hello there');
    expect(dmCrypto.sessionExists(PEER, MY_DEVICE)).toBe(true);

    // now a body from that sender that no session can open: no handshake to build from, and ciphertext
    // that is simply wrong. This is the shape an own-message echo takes, and what a hostile server can
    // substitute for anything.
    const unopenable = {
      kind: 'ratchet' as const,
      ciphertext: b64(crypto.getRandomValues(new Uint8Array(64))),
      ratchetPublicKey: b64(crypto.getRandomValues(new Uint8Array(33))),
      messageNumber: 0,
    };
    expect(await dmCrypto.openFor(PEER, unopenable, null)).toBeNull();

    // the session survived the body that was not for it
    expect(dmCrypto.sessionExists(PEER, MY_DEVICE)).toBe(true);

    // and the conversation still works on it, rather than needing a handshake that costs a prekey
    const bodies2 = await sealToEach(peer, PEER, [{ deviceId: MY_DEVICE, bundle: myBundle }], 'still here');
    expect(await dmCrypto.openFor(PEER, bodies2[0].body, null)).toBe('still here');
  }, 60000);
});