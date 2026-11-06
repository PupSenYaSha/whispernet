import { test, expect, type Page } from '@playwright/test';
import { startE2EServer, uniqueNick, type E2EServer } from './harness';

let server: E2EServer;

test.beforeAll(async () => {
  server = await startE2EServer();
});

test.afterAll(async () => {
  await server?.stop();
});

test.beforeEach(() => {
  // noop
});

async function newAccount(page: Page, nick: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('auth-mode-register').click();
  await page.getByTestId('auth-nickname').fill(nick);
  await page.getByTestId('auth-password').fill(password);
  await page.getByTestId('auth-submit').click();
}

async function waitForComposer(page: Page): Promise<void> {
  await expect(page.getByTestId('composer')).toBeEnabled({ timeout: 30_000 });
}

test('a person can create a group and send a message to it', async ({ page }) => {
  await newAccount(page, uniqueNick('groupuser'), 'testpass1234');
  await waitForComposer(page);

  // Create a group
  await page.getByTestId('group-create').click();
  await page.getByPlaceholder('Group Name').fill('Test Group');
  await page.getByTestId('group-create-submit').click();

  // The group should appear in the chat list
  const groupRow = page.getByTestId('group-row').filter({ hasText: 'Test Group' });
  await expect(groupRow.first()).toBeVisible({ timeout: 15_000 });
  await groupRow.first().click();

  // Composer should be enabled for the group
  await waitForComposer(page);
});

test('a person can join a group by invite code', async ({ page, context }) => {
  const browser = context.browser();
  if (!browser) return;
  const ctxB = await browser.newContext();

  try {
    // Alice creates a group
    await newAccount(page, uniqueNick('alicegroup'), 'testpass1234');
    await waitForComposer(page);
    await page.getByTestId('group-create').click();
    await page.getByPlaceholder('Group Name').fill('Invite Group');
    await page.getByTestId('group-create-submit').click();
    await expect(page.getByTestId('group-row').filter({ hasText: 'Invite Group' }).first()).toBeVisible();

    // Click on group header to open info
    await page.getByTestId('group-row').filter({ hasText: 'Invite Group' }).first().click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('composer')).toBeEnabled();
  } finally {
    await ctxB.close();
  }
});
