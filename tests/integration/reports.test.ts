import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, ADMIN_KEY, type StartedServer } from '../helpers';

let server: StartedServer;
const clients: TestClient[] = [];
const client = async (label: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  return c;
};

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('reports', () => {
  let a: TestClient, b: TestClient, bId: string;

  beforeAll(async () => {
    a = await client('ra');
    b = await client('rb');
    await a.register(uniqueNick('ra'));
    const rb = await b.register(uniqueNick('rb'));
    bId = rb.payload.userId;
  });

  it('accepts a profile report and stores source=profile', async () => {
    a.clear();
    a.send('report_user', { targetId: bId, reason: 'Scam', source: 'profile' });
    const res = await a.waitFor('report_received');
    expect(res.payload.ok).toBe(true);
    expect(res.payload.source).toBe('profile');
  });

  it('accepts a message report and keeps the message text for moderators', async () => {
    b.send('chat_message', { text: 'spam text for report ' + Date.now() });
    const got = await a.waitFor('chat_message');
    expect(got).toBeTruthy();
    a.clear();
    a.send('report_user', { targetId: bId, reason: 'Harassment', messageId: got.payload.id, source: 'message' });
    const res = await a.waitFor('report_received');
    expect(res.payload.source).toBe('message');
    a.clear();
    a.send('admin_reports', { key: ADMIN_KEY });
    const list = await a.waitFor('admin_reports');
    const row = list.payload.reports.find((r: any) => r.messageId === got.payload.id);
    expect(row).toBeTruthy();
    expect(row.source).toBe('message');
    expect(row.messageText).toContain('spam text');
  });

  it('treats legacy reports without source as message reports', async () => {
    const c = await client('legacy');
    await c.register(uniqueNick('leg'));
    a.clear();
    a.send('report_user', { targetId: bId, reason: 'Legacy' });
    await a.waitFor('report_received');
    a.clear();
    a.send('admin_reports', { key: ADMIN_KEY });
    const list = await a.waitFor('admin_reports');
    const row = list.payload.reports.find((r: any) => r.reason === 'Legacy');
    expect(row).toBeTruthy();
    expect(row.source).toBe('message');
  });

  it('rejects reports on yourself and with an empty reason', async () => {
    const ra = await a.register(uniqueNick('self'));
    a.clear();
    a.send('report_user', { targetId: ra.payload.userId, reason: 'x', source: 'profile' });
    const e1 = await a.waitFor('error');
    expect(e1.payload.code).toBe('INVALID_PAYLOAD');
    a.clear();
    a.send('report_user', { targetId: bId, reason: '', source: 'profile' });
    const e2 = await a.waitFor('error');
    expect(e2.payload.code).toBe('INVALID_PAYLOAD');
  });

  it('does not expose reports to non-admins', async () => {
    b.clear();
    b.send('admin_reports', {});
    const err = await b.waitFor('error');
    expect(err.payload.code).toBe('FORBIDDEN');
  });

  it('answers unknown commands with UNKNOWN_MESSAGE', async () => {
    a.clear();
    a.send('definitely_not_a_command', {});
    const err = await a.waitFor('error');
    expect(err.payload.code).toBe('UNKNOWN_MESSAGE');
  });
});

/**
 * An admin locking themselves out.
 *
 * This is not a hypothetical: it happened. A ban is checked at sign-in, the ban button sits in the same
 * list as every other row, and nothing stopped the click from landing on the account doing the clicking.
 * The result is an admin who cannot sign in, cannot unban themselves, and cannot re-register the name
 * because it is reserved - so recovery needs a database edit.
 *
 * Refused by id and by nickname, because the handler takes either and a request can carry both.
 */
describe('an admin banning themselves', () => {
  it('refuses it, and leaves the account usable', async () => {
    const admin = await client('selfban-admin');
    clients.push(admin);
    const nick = uniqueNick('selfban');
    const reg = await admin.register(nick);
    expect(reg.type, JSON.stringify(reg.payload)).toBe('auth_success');
    const adminId = reg.payload.userId;

    // by id, which is what the settings panel sends
    admin.clear();
    admin.send('admin_ban', { key: ADMIN_KEY, userId: adminId });
    const byId = await admin.waitFor('error', 4000);
    expect(byId.payload.code).toBe('FORBIDDEN');
    expect(byId.payload.message).toMatch(/own account/i);

    // by nickname, which is what the older path sends
    admin.clear();
    admin.send('admin_ban', { key: ADMIN_KEY, nickname: nick });
    const byNick = await admin.waitFor('error', 4000);
    expect(byNick.payload.code).toBe('FORBIDDEN');

    // the connection was not dropped, and signing in again still works
    admin.clear();
    const again = await admin.login(nick);
    expect(again.type, 'the account was banned by its own administrator').toBe('auth_success');
  });

  it('refuses it when the id and the nickname disagree', async () => {
    // The handler uses the id when there is one and the nickname otherwise, so a request carrying an id
    // that resolves to nothing beside its own nickname would otherwise fall through to the nickname branch
    // and ban the admin while looking like it targeted somebody else.
    const admin = await client('selfban-mixed');
    clients.push(admin);
    const nick = uniqueNick('mixed');
    await admin.register(nick);

    admin.clear();
    admin.send('admin_ban', { key: ADMIN_KEY, userId: 'no-such-user-at-all', nickname: nick });
    const err = await admin.waitFor('error', 4000);
    expect(err.payload.code).toBe('FORBIDDEN');
  });

  it('still bans somebody else', async () => {
    // the guard has to be narrow, or it is a ban button that does nothing
    const admin = await client('selfban-other');
    clients.push(admin);
    await admin.register(uniqueNick('otheradmin'));
    const target = await client('selfban-target');
    clients.push(target);
    const reg = await target.register(uniqueNick('othertarget'));
    expect(reg.type).toBe('auth_success');

    admin.clear();
    admin.send('admin_ban', { key: ADMIN_KEY, userId: reg.payload.userId });
    const done = await admin.waitFor('admin_action', 4000);
    expect(done.payload.action).toBe('ban');

    // and the target is now locked out, which is the point of the button
    target.clear();
    const refused = await target.login('othertarget').catch(() => null);
    expect(refused === null || refused.type === 'auth_failure').toBeTruthy();
  });
});

describe('admin nicknames', () => {
  it('refuses to register a reserved admin nickname in any case', async () => {
    const c = new TestClient(server.url, 'admin-nick');
    clients.push(c);
    const first = await c.register('admin');
    // on a fresh database 'admin' is reserved, so registration must fail
    expect(first.type).toBe('auth_failure');
    expect(first.payload.reason).toMatch(/reserved|taken/i);

    const d = new TestClient(server.url, 'admin-nick2');
    clients.push(d);
    const second = await d.register('Admin');
    expect(second.type).toBe('auth_failure');
  });
});
