import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

let server: StartedServer;
const clients: TestClient[] = [];

const open = async (ip: string, label: string) => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  await c.connect({ 'x-forwarded-for': ip });
  return c;
};

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  clients.forEach((c) => c.close());
  await server.stop();
});

describe('group chats', () => {
  it('creates a group and lists it', async () => {
    const a = await open('10.40.0.1', 'groupa');
    const ra = await a.register(uniqueNick('groupa'), {});
    expect(ra.type).toBe('auth_success');

    a.send('group_create', { name: 'Test Group', description: 'a test group' });
    const created = await a.waitFor('group_created', 5000);
    expect(created.type).toBe('group_created');
    expect(created.payload.name).toBe('Test Group');
    expect(created.payload.role).toBe('admin');

    a.send('group_list', {});
    const list = await a.waitFor('group_list', 5000);
    expect(list.type).toBe('group_list');
    expect(list.payload.groups.length).toBeGreaterThanOrEqual(1);
    expect(list.payload.groups.find((g: any) => g.name === 'Test Group')).toBeTruthy();
  });

  it('joins a group by invite code', async () => {
    const a = await open('10.40.0.2', 'groupjoina');
    const ra = await a.register(uniqueNick('groupjoina'), {});
    expect(ra.type).toBe('auth_success');

    a.send('group_create', { name: 'Invite Group' });
    const created = await a.waitFor('group_created', 5000);
    const inviteCode = created.payload.inviteCode;
    expect(inviteCode).toBeTruthy();

    const b = await open('10.40.0.3', 'groupjoinb');
    const rb = await b.register(uniqueNick('groupjoinb'), {});
    expect(rb.type).toBe('auth_success');

    b.send('group_join', { inviteCode });
    const joined = await b.waitFor('group_joined', 5000);
    expect(joined.type).toBe('group_joined');
    expect(joined.payload.groupId).toBe(created.payload.groupId);
  });

  it('sends and receives a group message', async () => {
    const a = await open('10.40.0.4', 'groupmsga');
    const ra = await a.register(uniqueNick('groupmsga'), {});
    expect(ra.type).toBe('auth_success');

    const b = await open('10.40.0.5', 'groupmsgb');
    const rb = await b.register(uniqueNick('groupmsgb'), {});
    expect(rb.type).toBe('auth_success');

    a.send('group_create', { name: 'Message Group' });
    const created = await a.waitFor('group_created', 5000);
    const groupId = created.payload.groupId;

    b.send('group_join', { groupId });
    await b.waitFor('group_joined', 5000);

    const text = `group hello ${Date.now()}`;
    a.send('group_message', { groupId, text });

    const received = await b.waitFor('group_message', 5000);
    expect(received.type).toBe('group_message');
    expect(received.payload.text).toBe(text);
    expect(received.payload.senderId).toBe(ra.payload.userId);
  });

  it('leaves a group', async () => {
    const a = await open('10.40.0.6', 'groupeleva');
    const ra = await a.register(uniqueNick('groupeleva'), {});
    expect(ra.type).toBe('auth_success');

    const b = await open('10.40.0.7', 'groupelevb');
    const rb = await b.register(uniqueNick('groupelevb'), {});
    expect(rb.type).toBe('auth_success');

    a.send('group_create', { name: 'Leave Group' });
    const created = await a.waitFor('group_created', 5000);
    const groupId = created.payload.groupId;

    b.send('group_join', { groupId });
    await b.waitFor('group_joined', 5000);

    b.send('group_leave', { groupId });
    const left = await b.waitFor('group_left', 5000);
    expect(left.type).toBe('group_left');
    expect(left.payload.groupId).toBe(groupId);
  });

  it('gets group info and members', async () => {
    const a = await open('10.40.0.7', 'groupinfoa');
    const ra = await a.register(uniqueNick('groupinfoa'), {});
    expect(ra.type).toBe('auth_success');

    a.send('group_create', { name: 'Info Group' });
    const created = await a.waitFor('group_created', 5000);
    const groupId = created.payload.groupId;

    a.send('group_info', { groupId });
    const info = await a.waitFor('group_info', 5000);
    expect(info.type).toBe('group_info');
    expect(info.payload.groupId).toBe(groupId);
    expect(info.payload.name).toBe('Info Group');

    a.send('group_members', { groupId });
    const members = await a.waitFor('group_members', 5000);
    expect(members.type).toBe('group_members');
    expect(members.payload.members.length).toBeGreaterThanOrEqual(1);
    expect(members.payload.members.find((m: any) => m.userId === ra.payload.userId)).toBeTruthy();
  });
});
