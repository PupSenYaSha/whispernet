import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';
import { MAX_CONNECTIONS_PER_USER } from '../../server/constants';

let server: StartedServer;
const clients: TestClient[] = [];

const client = async (label: string, ip?: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  if (ip) await c.connect({ 'x-forwarded-for': ip });
  return c;
};

// rate limits have to be on here, they are what these tests exercise
beforeAll(async () => { server = await startTestServer({ DISABLE_RATE_LIMITS: '0' }); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('shared networks', () => {
  it('lets many accounts connect from one address', async () => {
    const ip = '10.1.0.1';
    for (let i = 0; i < 12; i++) {
      const c = await client('nat' + i, ip);
      const res = await c.register(uniqueNick('nat'));
      expect(res.type).toBe('auth_success');
    }
  }, 30000);

  it('counts open clients per account, not per address', async () => {
    const ip = '10.1.0.2';
    const nick = uniqueNick('multi');
    const first = await client('multi-1', ip);
    await first.register(nick);

    let rejected = 0;
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
      const c = await client('multi-x' + i, ip);
      const res = await c.login(nick);
      if (res.type === 'auth_failure') rejected++;
    }
    // the first connection is already open, so the per account cap has to refuse the rest
    expect(rejected).toBeGreaterThan(0);
  }, 30000);
});
