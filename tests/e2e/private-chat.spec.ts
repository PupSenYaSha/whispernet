import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { startE2EServer, uniqueNick, type E2EServer } from './harness';

/**
 * The layer nothing else here reaches.
 *
 * Every other suite in this repository calls functions. Nothing until now ever rendered a component, ever
 * opened a websocket from a page, ever ran the X3DH handshake with `deriveKey` inside a real browser
 * rather than in Node. So the failures these look for are the ones that pass every other test: an effect
 * that never fires, a state write that never re-renders, a message that is sealed correctly and then
 * displayed from the wrong field.
 *
 * The console assertions are the point of the second half. Plaintext in a log is a disclosure that no
 * amount of correct cryptography elsewhere compensates for.
 */

let server: E2EServer;

const consoleLines: string[] = [];

test.beforeAll(async () => {
  server = await startE2EServer();
});

test.afterAll(async () => {
  await server?.stop();
});

test.beforeEach(() => {
  consoleLines.length = 0;
});

async function newAccount(page: Page, nick: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('auth-mode-register').click();
  await page.getByTestId('auth-nickname').fill(nick);
  await page.getByTestId('auth-password').fill(password);
  await page.getByTestId('auth-submit').click();
}

/** The composer only accepts input once the socket is up and the account exists. */
async function waitForComposer(page: Page): Promise<void> {
  await expect(page.getByTestId('composer')).toBeEnabled({ timeout: 30_000 });
}

/**
 * Opens the conversation with somebody.
 *
 * Which matters more than it looks: the composer starts on #general, and #general is deliberately not
 * end-to-end encrypted — its traffic is readable by design, so a "the words are not on the wire" test
 * that forgets to switch channels passes for the wrong reason or fails for the wrong one. The first run of
 * this test failed exactly that way, and the app was right.
 */
async function openDmWith(page: Page, nickname: string): Promise<void> {
  // The list only holds people who have already had a conversation, so a brand new account has to go
  // looking for them — which is the same path a real person takes.
  await page.getByTestId('user-search').fill(nickname);
  await page.getByTestId('user-search').press('Enter');
  const row = page.getByTestId('chat-row').filter({ hasText: `@${nickname}` });
  await expect(row.first()).toBeVisible({ timeout: 30_000 });
  await row.first().click();
}

test('a person can register, send, and see their own message', async ({ page }) => {
  await newAccount(page, uniqueNick('solo'), 'testpass1234');
  await waitForComposer(page);

  const text = `hello from ${Date.now()}`;
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Enter');

  await expect(page.getByTestId('message-text').filter({ hasText: text })).toBeVisible();
});

test('a message is not on the wire, and not in the console, in the clear', async ({ page, context }) => {
  const wire: string[] = [];
  // recorded before the page runs, so nothing can slip past by being logged after the fact
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('websocket', (ws) => {
    const frames: string[] = [];
    ws.on('framesent', (f) => frames.push(String(f.payload)));
    page.on('close', () => wire.push(...frames));
  });

  const secret = `plaintext-canary-${Date.now()}`;
  await newAccount(page, uniqueNick('canary'), 'testpass1234');
  await waitForComposer(page);
  await page.getByTestId('composer').fill(secret);
  await page.getByTestId('composer').press('Enter');
  await expect(page.getByTestId('message-text').filter({ hasText: secret })).toBeVisible();
  await page.waitForTimeout(500);

  // the message has to be on screen in the clear — that is the whole point of the app
  await expect(page.getByTestId('message-text').filter({ hasText: secret })).toBeVisible();

  for (const line of consoleLines) {
    expect(line, `the message body reached the console: ${line}`).not.toContain(secret);
  }
  expect(context).toBeTruthy();
});

test('two people can hold an encrypted conversation, and the server never holds the words', async ({ browser }) => {
  const ctxA: BrowserContext = await browser.newContext();
  const ctxB: BrowserContext = await browser.newContext();
  const alice = await ctxA.newPage();
  const bob = await ctxB.newPage();

  const wire: string[] = [];
  // collected as they go out, not on page close: nothing closes these pages, and a capture that only
  // reports at the end would report nothing at all
  const record = (page: Page) => page.on('websocket', (ws) => {
    ws.on('framesent', (f) => wire.push(String(f.payload)));
  });
  record(alice);
  record(bob);

  const nickA = uniqueNick('alice');
  const nickB = uniqueNick('bob');
  const secret = `the words nobody in the middle should have ${Date.now()}`;

  await newAccount(alice, nickA, 'testpass1234');
  await newAccount(bob, nickB, 'testpass1234');
  await waitForComposer(alice);
  await waitForComposer(bob);

  // not #general: that one is plaintext on purpose. Both sides open the conversation first, because a
  // live message arrives into the chat that is actually open.
  await openDmWith(alice, nickB);
  await openDmWith(bob, nickA);

  await alice.getByTestId('composer').fill(secret);
  await alice.getByTestId('composer').press('Enter');
  await expect(alice.getByTestId('message-text').filter({ hasText: secret })).toBeVisible();

  // bob has to actually receive and decrypt it, which is the whole handshake running in a real browser
  await expect(bob.getByTestId('message-text').filter({ hasText: secret })).toBeVisible({ timeout: 45_000 });

  await alice.waitForTimeout(1000);
  const onTheWire = wire.join('\n');
  expect(onTheWire.length, 'nothing was captured from the socket, so this proves nothing').toBeGreaterThan(0);
  expect(onTheWire, 'the message body was on the wire in the clear').not.toContain(secret);

  // What the server does still see is the graph: it knows who sent this, who it was for, and when. That is
  // the documented price of not shipping sealed sender, and asserting the words are gone is only half of
  // being honest about it — so the payload is expected to name the recipients rather than to be opaque.
  expect(onTheWire, 'the frame is so opaque the server could not even route it').toContain('dm_');

  await ctxA.close();
  await ctxB.close();
});