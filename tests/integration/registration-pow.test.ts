import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';
import { searchSolution } from '../../src/registerPow';

/**
 * The server's half of the registration proof.
 *
 * The whole brake rests on two things: a registration without a good proof creates nothing, and a proof can
 * be spent only once. Both are checked here against the real server, because a verifier that quietly accepts
 * is worse than no verifier at all - the cost would still be charged to honest users and nothing would be
 * bought with it.
 *
 * Solved here with the client's own searcher rather than a fixture, so the two implementations are
 * exercised against each other instead of against a hard-coded nonce that would stop being valid the moment
 * the difficulty or the format changed.
 */

let server: StartedServer;
const clients: TestClient[] = [];

const BITS = 10; // about a millisecond: the cost is not what these tests are about

/** Counts leading zero bits exactly as the server does, to confirm a fixture really qualifies. */
function bitsOf(challenge: string, nonce: number): number {
  const digest = crypto.createHash('sha256').update(`${nonce}:${challenge}`).digest();
  let bits = 0;
  for (const b of digest) {
    if (b === 0) { bits += 8; continue; }
    return bits + (Math.clz32(b) - 24);
  }
  return bits;
}

async function startRegistration(ip: string, deviceId: string) {
  const c = new TestClient(server.url, 'pow');
  clients.push(c);
  await c.connect({ 'x-forwarded-for': ip });
  // The challenge is the *answer* to a registration attempt, so one has to be made first.
  c.send('auth_register', { nickname: uniqueNick('pow'), password: 'pass123456', deviceId });
  const challenge = await c.waitFor('auth_pow_challenge', 5000);
  return { c, challenge, nickname: uniqueNick('pow') };
}

beforeAll(async () => {
  // POW_BITS has to be set before the server module loads, which is why this file stands alone.
  server = await startTestServer({ POW_BITS: String(BITS), DISABLE_RATE_LIMITS: '0', MAX_REGISTRATIONS_PER_IP: '1000', MAX_ACCOUNTS_PER_DEVICE: '1000' });
});

afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('the registration proof', () => {
  it('refuses to create an account without one', async () => {
    const c = new TestClient(server.url, 'nopow');
    clients.push(c);
    await c.connect({ 'x-forwarded-for': '198.51.100.20' });
    c.send('auth_register', { nickname: uniqueNick('pow'), password: 'pass123456', deviceId: 'd-nopow' });
    // No auth_success and no auth_failure: the answer is a challenge, and the account does not exist yet.
    const challenge = await c.waitFor('auth_pow_challenge', 5000);
    expect(challenge, 'the server answered without being asked for a proof').toBeTruthy();
    expect(challenge.payload.challenge).toMatch(/^[0-9a-f]{32}$/);
    expect(challenge.payload.bits).toBe(BITS);
    expect(c.logs.find((m) => m.type === 'auth_success')).toBeFalsy();
  }, 30000);

  it('creates the account once a good proof arrives', async () => {
    const { c, challenge } = await startRegistration('198.51.100.21', 'd-good');
    const nonce = searchSolution(challenge.payload.challenge, challenge.payload.bits) as number;
    expect(bitsOf(challenge.payload.challenge, nonce)).toBeGreaterThanOrEqual(BITS);

    c.clear();
    c.send('auth_register', {
      nickname: uniqueNick('pow'), password: 'pass123456', deviceId: 'd-good',
      powChallenge: challenge.payload.challenge, powNonce: nonce,
    });
    const ok = await c.waitFor('auth_success', 8000);
    expect(ok, `expected success, got: ${JSON.stringify(c.logs.map((m) => m.type))}`).toBeTruthy();
  }, 30000);

  it('turns down a proof for a difficulty it did not ask for', async () => {
    // The dangerous case: if the server trusted the difficulty in the request, difficulty zero would be a
    // valid answer to anything, and the brake could be removed by adding one field to a request.
    const { c, challenge } = await startRegistration('198.51.100.22', 'd-low');
    c.clear();
    c.send('auth_register', {
      nickname: uniqueNick('pow'), password: 'pass123456', deviceId: 'd-low',
      powChallenge: challenge.payload.challenge, powNonce: 0, powBits: 0,
    });
    const refusal = await c.waitFor('auth_pow_challenge', 5000);
    expect(refusal, 'a client-supplied difficulty was believed').toBeTruthy();
    expect(refusal.payload.challenge).not.toBe(challenge.payload.challenge);
    expect(c.logs.find((m) => m.type === 'auth_success')).toBeFalsy();
  }, 30000);

  it('refuses a nonce that does not reach the difficulty', async () => {
    const { c, challenge } = await startRegistration('198.51.100.23', 'd-wrong');
    c.clear();
    // A nonce of 0 will not normally qualify; the test checks the outcome either way, because what matters
    // is that a non-qualifying nonce does not create an account.
    c.send('auth_register', {
      nickname: uniqueNick('pow'), password: 'pass123456', deviceId: 'd-wrong',
      powChallenge: challenge.payload.challenge, powNonce: 0,
    });
    if (bitsOf(challenge.payload.challenge, 0) >= BITS) return; // absurdly lucky; nothing to assert
    await new Promise((r) => setTimeout(r, 400));
    expect(c.logs.find((m) => m.type === 'auth_success')).toBeFalsy();
  }, 30000);

  it('will not let one proof be spent twice', async () => {
    // Without this, a single search would authorise any number of accounts and the cost of the hundredth
    // would be the same as the cost of the first.
    const { c, challenge } = await startRegistration('198.51.100.24', 'd-replay');
    const nonce = searchSolution(challenge.payload.challenge, challenge.payload.bits) as number;

    c.clear();
    c.send('auth_register', {
      nickname: uniqueNick('pow'), password: 'pass123456', deviceId: 'd-replay',
      powChallenge: challenge.payload.challenge, powNonce: nonce,
    });
    expect(await c.waitFor('auth_success', 8000), 'the first use should succeed').toBeTruthy();

    c.clear();
    c.send('auth_register', {
      nickname: uniqueNick('pow'), password: 'pass123456', deviceId: 'd-replay',
      powChallenge: challenge.payload.challenge, powNonce: nonce,
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(c.logs.find((m) => m.type === 'auth_success'), 'the same proof created a second account').toBeFalsy();
  }, 30000);

  it('ignores a proof it never issued', async () => {
    const { c, challenge } = await startRegistration('198.51.100.25', 'd-forged');
    const forged = crypto.randomBytes(16).toString('hex');
    expect(forged).not.toBe(challenge.payload.challenge);
    // Solved honestly for a challenge the server never issued - the server cannot check the work, only
    // whether it issued the question.
    const nonce = searchSolution(forged, BITS) as number;
    c.clear();
    c.send('auth_register', {
      nickname: uniqueNick('pow'), password: 'pass123456', deviceId: 'd-forged',
      powChallenge: forged, powNonce: nonce,
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(c.logs.find((m) => m.type === 'auth_success')).toBeFalsy();
  }, 30000);

  it('does not ask for a proof when signing in', async () => {
    // Login has to stay instant. A proof here would mean signing in cost three seconds on every launch,
    // for no benefit: the thing being prevented is *creating* accounts.
    const { c, challenge } = await startRegistration('198.51.100.26', 'd-login');
    const nonce = searchSolution(challenge.payload.challenge, challenge.payload.bits) as number;
    c.clear();
    c.send('auth_register', {
      nickname: uniqueNick('pow'), password: 'pass123456', deviceId: 'd-login',
      powChallenge: challenge.payload.challenge, powNonce: nonce,
    });
    await c.waitFor('auth_success', 8000);

    const again = new TestClient(server.url, 'login');
    clients.push(again);
    await again.connect({ 'x-forwarded-for': '198.51.100.27' });
    again.send('auth_login', { nickname: uniqueNick('none'), password: 'pass123456', deviceId: 'd-login' });
    // Whatever the answer, it must not be a proof request.
    await new Promise((r) => setTimeout(r, 500));
    expect(again.logs.find((m) => m.type === 'auth_pow_challenge')).toBeFalsy();
  }, 30000);
});
