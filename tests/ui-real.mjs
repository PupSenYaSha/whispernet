import { chromium } from '@playwright/test';

const BASE = process.env.WN_EXTERNAL_URL || 'http://127.0.0.1:8099';

function assert(cond, msg) {
  if (!cond) { throw new Error('ASSERT FAILED: ' + msg); }
  console.log('OK: ' + msg);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

const nick = 'ui_' + Math.random().toString(36).slice(2, 8);
const pass = 'Passw0rd123';
const text = 'hello-from-real-browser-' + Date.now();

try {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  // 1) Auth screen rendered (real client bundle executed)
  const nickInput = page.locator('input[maxlength="16"]');
  await nickInput.waitFor({ state: 'visible', timeout: 15000 });
  assert(true, 'client bundle loaded, login screen rendered');

  // 1a) Default language is English (base language flipped to 'en')
  const registerBtn = page.getByRole('button', { name: /register|регистрация/i });
  const registerLabel = (await registerBtn.innerText()).trim().toLowerCase();
  assert(/register/.test(registerLabel), 'default language is English (button reads "' + registerLabel + '")');

  // 1b) Bundled Inter font is actually applied (not a system font)
  await page.evaluate(() => document.fonts.ready);
  const fontOk = await page.evaluate(() => document.fonts.check('16px Inter'));
  assert(fontOk, 'bundled Inter webfont loaded and usable');

  // 1c) New visual CSS shipped: ambient glow + @font-face present in stylesheets
  const cssHasGlow = await page.evaluate(() =>
    [...document.styleSheets].some((s) => {
      try { return [...s.cssRules].some((r) => r.cssText.includes('radial-gradient(60rem')); } catch { return false; }
    })
  );
  assert(cssHasGlow, 'new visual CSS (ambient accent glow) is live');

  // 2) Register via real UI
  await registerBtn.click();
  await nickInput.fill(nick);
  await page.locator('input[maxlength="32"]').fill(pass);
  await page.locator('button[type="submit"]').click();

  // 3) Transition to authenticated chat (composer appears)
  const composer = page.getByPlaceholder(/message|сообщение/i);
  await composer.waitFor({ state: 'visible', timeout: 15000 });
  assert(true, 'registration succeeded, reached authenticated chat UI');

  // 4) Send a real text message and see it render
  await composer.fill(text);
  await composer.press('Enter');
  await page.getByText(text, { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
  assert(true, 'text message sent and rendered in UI: ' + text);

  // 5) Settings opens and shows new UI sections in English
  await page.getByRole('button', { name: /settings|настройки/i }).first().click();
  const blockedSection = page.getByText('Blocked Users', { exact: true });
  await blockedSection.waitFor({ state: 'visible', timeout: 10000 });
  assert(true, 'settings opens; "Blocked Users" section present');
  const securitySection = page.getByText('Security', { exact: false });
  assert((await securitySection.count()) > 0, 'security section present');
  await page.keyboard.press('Escape');
  await page.getByText(text, { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });

  // 6) No runtime errors in the real browser
  assert(pageErrors.length === 0, 'no page/console errors (' + pageErrors.length + ')');
  if (pageErrors.length) console.log(pageErrors.join('\n'));

  console.log('UI_REAL_TEST_PASS');
} catch (e) {
  console.error('UI_REAL_TEST_FAIL', e.message);
  if (pageErrors.length) console.error('PAGE ERRORS:\n' + pageErrors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
