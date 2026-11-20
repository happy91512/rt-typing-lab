import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openTravelPanel(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '開始基準測試' }).click();
  const panel = page.locator('.travel-panel');
  await panel.locator('summary').click();
  return panel;
}

test('a failed WebHID request and a dismissed retry leave baseline typing usable', async ({ page }) => {
  await page.addInitScript(() => {
    let attempts = 0;
    const hid = Object.assign(new EventTarget(), {
      requestDevice() {
        if (++attempts === 1) return Promise.reject(new Error('測試用的 WebHID 連線錯誤'));
        return new Promise((_, reject) =>
          window.addEventListener('reject-test-webhid', () => reject(new Error('已失效的重試錯誤')), { once: true }),
        );
      },
    });
    Object.defineProperty(navigator, 'hid', { value: hid });
  });

  const panel = await openTravelPanel(page);
  const connect = panel.getByRole('button', { name: '連線並量測', includeHidden: true });
  const disconnect = panel.getByRole('button', { name: '結束量測', includeHidden: true });
  const status = panel.locator('[data-travel-message]');
  await connect.click();
  await expect(status).toHaveText('測試用的 WebHID 連線錯誤');
  await expect(connect).toBeEnabled();
  await expect(disconnect).toBeDisabled();

  await connect.click();
  await expect(connect).toBeDisabled();
  await expect(disconnect).toBeEnabled();
  await panel.locator('summary').click();
  await expect(panel).toHaveJSProperty('open', false);
  await expect(connect).toBeEnabled();
  await expect(disconnect).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('reject-test-webhid')));
  await expect(status).toHaveText('');

  const reference = await page.locator('[data-prompt]').evaluate(node => node.textContent ?? '');
  expect(reference).not.toBe('');
  await page.getByRole('button', { name: '開始這題' }).click();
  const input = page.getByRole('region', { name: '實體鍵輸入區' });
  await expect(input).toBeFocused();
  await input.pressSequentially(reference);
  await expect(page.locator('[data-count]')).toHaveText(`${reference.length} / ${reference.length}`);
  await page.getByRole('button', { name: '送出這題' }).click();
  await expect(page.getByRole('progressbar', { name: '已完成的基準題數' })).toHaveJSProperty('value', 1);
});

test('without WebHID the travel panel leaves the typing controls available', async ({ page }) => {
  await page.addInitScript(() => Reflect.deleteProperty(Navigator.prototype, 'hid'));
  const panel = await openTravelPanel(page);
  await expect(panel.getByRole('status')).toHaveText('此瀏覽器沒有 WebHID，仍可做完整的打字比較。');
  await expect(panel.getByRole('button', { name: '連線並量測' })).toBeDisabled();
  const start = page.getByRole('button', { name: '開始這題' });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(panel).toHaveJSProperty('open', false);
  await expect(page.getByRole('region', { name: '實體鍵輸入區' })).toBeFocused();
});
