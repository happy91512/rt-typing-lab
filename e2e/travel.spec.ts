import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openTravelPanel(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '開始基準測試' }).click();
  const panel = page.locator('.travel-panel');
  await panel.locator(':scope > summary').click();
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
  await panel.locator(':scope > summary').click();
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

test('reads live travel and waits for the device to stop when the panel closes', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.addInitScript(() => {
    const state = { requestedPosition: -1, stopRequested: false, stopAcknowledged: false, closed: false };
    class SimulatedKeyboard extends EventTarget {
      opened = false;
      readonly vendorId = 0x372e;
      readonly productId = 0x103e;
      readonly collections = [{ inputReports: [{ reportId: 9 }], outputReports: [{ reportId: 9 }] }];

      async open() { this.opened = true; }
      async close() {
        if (!state.stopAcknowledged) throw new Error('Device closed before acknowledging stop');
        this.opened = false;
        state.closed = true;
      }

      async sendReport(reportId: number, bytes: Uint8Array) {
        if (reportId !== 9) throw new Error('Unexpected report ID');
        const [command, operation, , , , , high, low] = bytes;
        if (command === 0x82) {
          this.report([0x82, 1, 0, 1, 0, 6, 0x11, 0, 0, 0, 0, 5, 0]);
        } else if (operation === 1) {
          state.requestedPosition = high * 256 + low;
          this.report([0x98, 1, 0, 1, 0, 6, 0, 70, 0x12, 0x34, 0x80, 0]);
        } else if (operation === 2) {
          state.stopRequested = true;
          await new Promise<void>(resolve => window.addEventListener('ack-test-webhid-stop', () => {
            state.stopAcknowledged = true;
            this.report([0x98, 2, 0, 1, 0, 0, 0, 0]);
            resolve();
          }, { once: true }));
        } else {
          this.report([0x98, 0, 0, 1, 0, 0, 0, 0]);
        }
      }

      private report(bytes: number[]) {
        this.dispatchEvent(Object.assign(new Event('inputreport'), {
          device: this,
          reportId: 9,
          data: new DataView(Uint8Array.from(bytes).buffer),
        }));
      }
    }
    const keyboard = new SimulatedKeyboard();
    const hid = Object.assign(new EventTarget(), {
      requestDevice: async () => [keyboard],
      snapshot: () => ({ ...state }),
    });
    Object.defineProperty(navigator, 'hid', { value: hid });
  });

  const panel = await openTravelPanel(page);
  const storageBefore = await page.evaluate(() => Object.entries(localStorage));
  const deviceState = () => page.evaluate(() => {
    if ('hid' in navigator && navigator.hid instanceof EventTarget
      && 'snapshot' in navigator.hid && typeof navigator.hid.snapshot === 'function') {
      return navigator.hid.snapshot();
    }
    throw new Error('Missing simulated keyboard');
  });
  await panel.getByLabel('測量鍵位').selectOption('Space');
  const connect = panel.getByRole('button', { name: '連線並量測', includeHidden: true });
  await connect.click();
  await expect(panel.locator('[data-reading]')).toContainText('讀值 4660，按下');
  const calibration = panel.getByLabel('行程校準按鍵區');
  await expect(calibration).toBeFocused();
  await calibration.press('Space');
  await expect(panel.locator('[data-quality]')).toContainText(/事件對齊 \d+ \/ 2/);
  await expect.poll(deviceState).toEqual({
    requestedPosition: 70, stopRequested: false, stopAcknowledged: false, closed: false,
  });

  const probe = panel.getByRole('button', { name: '測試取樣速度（4 秒）' });
  await probe.click();
  await expect(probe).toBeDisabled();
  await expect(calibration).toBeFocused();
  await page.clock.runFor(4000);
  await expect(probe).toBeEnabled();
  await expect(panel.locator('[data-cadence-result]')).toContainText('中位間隔 20.0 ms／筆');
  expect(await page.evaluate(() => Object.entries(localStorage))).toEqual(storageBefore);

  await panel.locator(':scope > summary').click();
  await expect(panel).toHaveJSProperty('open', false);
  await expect.poll(deviceState).toEqual({
    requestedPosition: 70, stopRequested: true, stopAcknowledged: false, closed: false,
  });
  await expect(connect).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('ack-test-webhid-stop')));
  await expect(connect).toBeEnabled();
  await expect.poll(deviceState).toEqual({
    requestedPosition: 70, stopRequested: true, stopAcknowledged: true, closed: true,
  });
  expect(await page.evaluate(() => Object.entries(localStorage))).toEqual(storageBefore);
});

test('adds an aligned replay improvement as a pending candidate without saving travel samples', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.addInitScript(() => {
    class SimulatedKeyboard extends EventTarget {
      opened = false;
      readonly vendorId = 0x372e;
      readonly productId = 0x103e;
      readonly collections = [{ inputReports: [{ reportId: 9 }], outputReports: [{ reportId: 9 }] }];
      private initial = true;

      constructor() {
        super();
        window.addEventListener('test-travel-reading', event => {
          const { raw, pressed } = (event as CustomEvent<{ raw: number; pressed: boolean }>).detail;
          this.sample(raw, pressed);
        });
      }

      async open() { this.opened = true; }
      async close() { this.opened = false; }
      async sendReport(_: number, bytes: Uint8Array) {
        const [command, operation] = bytes;
        if (command === 0x82) this.report([0x82, 1, 0, 1, 0, 6, 0x11, 0, 0, 0, 0, 5, 0]);
        else if (operation !== 1) this.report([0x98, operation, 0, 1, 0, 0, 0, 0]);
        else if (this.initial) {
          this.initial = false;
          this.sample(0, false);
        }
      }

      private sample(raw: number, pressed: boolean) {
        this.report([0x98, 1, 0, 1, 0, 6, 0, 29, raw >> 8, raw & 255, pressed ? 128 : 0, 0]);
      }

      private report(bytes: number[]) {
        this.dispatchEvent(Object.assign(new Event('inputreport'), {
          device: this, reportId: 9, data: new DataView(Uint8Array.from(bytes).buffer),
        }));
      }
    }
    const keyboard = new SimulatedKeyboard();
    Object.defineProperty(navigator, 'hid', {
      value: Object.assign(new EventTarget(), { requestDevice: async () => [keyboard] }),
    });
  });

  const panel = await openTravelPanel(page);
  await panel.getByRole('button', { name: '連線並量測' }).click();
  await panel.getByText('用行程試算 RT 候選值').click();
  await panel.getByLabel('首次觸發點').fill('1.00');
  await panel.getByLabel('軸體總行程').fill('3.40');
  await panel.getByLabel('頂部死區').fill('0.26');
  await panel.getByLabel('底部死區').fill('0.25');
  await panel.getByRole('button', { name: '準備試算短題' }).click();

  const sample = async (depth: number, pressed: boolean) => {
    await page.clock.runFor(15);
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent('test-travel-reading', { detail })),
      { raw: depth * 10, pressed });
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    await panel.getByRole('button', { name: '開始這題' }).click();
    await sample(100, true);
    await page.keyboard.down('q');
    await sample(140, true);
    await sample(attempt % 2 === 0 ? 124 : 110, false);
    await page.keyboard.up('q');
    await sample(140, true);
    await page.keyboard.down('q');
    await sample(140, true);
    await sample(0, false);
    await page.keyboard.up('q');
    await sample(0, false);
    await panel.getByRole('button', { name: '完成這題' }).click();
    await expect(panel.locator('[data-exercise-cadence]')).toContainText('上一題中位間隔 15.0 ms');
  }
  await expect(panel.locator('[data-exercise-note]')).toContainText('待驗證 0.17 mm');
  await panel.getByRole('button', { name: '加入 A/B 候選' }).click();
  await expect(panel.locator('[data-exercise-note]')).toContainText('已將 0.17 mm 加入待驗證');
  const raw = await page.evaluate(() => localStorage.getItem('rt-typing-lab.study'));
  expect(JSON.parse(raw ?? '')).toMatchObject({
    baseline: [],
    trials: [],
    travelTargets: [{ code: 'KeyQ', distance: 17, source: 'travel' }],
  });
  expect(raw).not.toMatch(/rawTravel|receivedAt|samples|edges/);
});
