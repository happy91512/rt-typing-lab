import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { restoreStudy, storageKey } from '../src/study.ts';

const rounds = { english: '英文打字', chinese: '繁中打字', drill: '實體鍵短測' };
type Kind = keyof typeof rounds;

async function completeRound(page: Page, kind: Kind, options: { extraF?: boolean; pauseMs?: number } = {}) {
  const round = page.locator('#round');
  await expect(round.getByRole('heading', { name: rounds[kind] })).toBeVisible();
  const prompt = round.locator('[data-prompt]');
  const text = kind === 'chinese'
    ? await prompt.evaluate(node => node.textContent ?? '')
    : await prompt.locator('.prompt-char').evaluateAll(nodes =>
      nodes.map(node => node.firstChild?.textContent ?? '').join('').replaceAll('␣', ' '),
    );

  expect(text.length).toBeGreaterThan(0);
  const entered = options.extraF ? text.replace('f', 'ff') : text;
  const split = options.pauseMs ? Math.floor(entered.length / 2) : entered.length;
  const first = entered.slice(0, split);
  const second = entered.slice(split);
  await round.getByRole('button', { name: '開始這題' }).click();
  if (kind === 'chinese') {
    await expect(round.getByRole('textbox', { name: '輸入繁中測試文字' })).toBeFocused();
    await page.keyboard.insertText(first);
    if (options.pauseMs) {
      await page.clock.runFor(options.pauseMs);
      await page.keyboard.insertText(second);
    }
  } else {
    const input = round.getByRole('region', { name: '實體鍵輸入區' });
    await expect(input).toBeFocused();
    await input.pressSequentially(first, { delay: 0 });
    if (options.pauseMs) {
      await page.clock.runFor(options.pauseMs);
      await input.pressSequentially(second, { delay: 0 });
    }
  }
  const length = Array.from(text).length;
  await expect(round.locator('[data-count]')).toHaveText(`${Array.from(entered).length} / ${length}`);
  await round.getByRole('button', { name: '送出這題' }).click();
  return text;
}

async function savedStudy(page: Page) {
  const raw = await page.evaluate(key => localStorage.getItem(key), storageKey);
  expect(raw).not.toBeNull();
  const study = restoreStudy(raw ?? '');
  if (!study || raw === null) throw new Error('Missing or invalid persisted study');
  return { raw, study };
}

test('complete a baseline and A/B pairs, verify the recommendation on new text, and export aggregates', async ({ page, baseURL }) => {
  const externalRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== baseURL || request.method() !== 'GET') externalRequests.push(request.url());
  });
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '找到適合你的逐鍵 RT' })).toBeVisible();
  await expect(page.locator('.keyboard .key')).toHaveCount(84);
  await expect(page.getByLabel('目前 RT（關閉時填開啟後的起始值）')).toHaveValue('0.15');
  await expect(page.locator('#setup-form').getByLabel('目前已開啟 RT')).toBeChecked();
  await expect(page.getByRole('button', { name: /換值比較/ })).toBeDisabled();
  await page.getByRole('button', { name: '開始基準測試' }).click();

  const firstPrompt = await completeRound(page, 'english');
  const secondPrompt = await page.locator('[data-prompt]').textContent();
  const unfinishedText = 'zzunfinished';
  await page.getByRole('button', { name: '開始這題' }).click();
  await page.getByRole('region', { name: '實體鍵輸入區' }).pressSequentially(unfinishedText);
  await expect(page.locator('[data-count]')).toHaveText(/^12 \/ /);
  const { raw: beforeReload } = await savedStudy(page);
  expect(beforeReload).not.toContain(unfinishedText);
  await page.reload();
  await expect(page.getByRole('heading', { name: '建立打字基準', level: 1 })).toBeVisible();
  await expect(page.locator('[data-count]')).toHaveText(/^0 \/ /);
  await expect(page.locator('[data-prompt]')).toHaveText(secondPrompt ?? '');
  expect((await savedStudy(page)).study.baseline).toHaveLength(1);

  const passages = [
    firstPrompt,
    await completeRound(page, 'english'),
    await completeRound(page, 'chinese'),
    await completeRound(page, 'chinese'),
  ];
  await completeRound(page, 'drill');
  await page.getByRole('button', { name: '查看逐鍵結果' }).click();
  const coverage = page.locator('[data-baseline-coverage]');
  const startCoverage = Number((await coverage.textContent())?.match(/(\d+)／48/)?.[1]);
  expect(startCoverage).toBeLessThan(48);
  await page.getByRole('button', { name: '補測低樣本鍵' }).click();
  const targets = (await savedStudy(page)).study.supplements[0].targets;
  expect(targets).toHaveLength(6);
  await page.reload();
  await expect(page.getByRole('heading', { name: '低樣本鍵補測' })).toBeVisible();
  expect((await savedStudy(page)).study.supplements[0].targets).toEqual(targets);
  await page.getByRole('button', { name: '已回到 A 原設定' }).click();
  const supplement = await completeRound(page, 'drill');
  await expect(coverage).toContainText(`${startCoverage + targets.length}／48`);
  await page.getByRole('button', { name: '測試另一組鍵' }).click();
  const beginComparison = page.getByRole('button', { name: '開始三對比較' });
  await expect(beginComparison).toBeDisabled();
  await page.getByLabel('選擇鍵位').selectOption('KeyF');
  await page.getByLabel('候選值').fill('0.20');
  await page.getByRole('button', { name: '新增或更新候選鍵' }).click();
  const candidate = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'F', exact: true }) });
  await expect(candidate).toContainText('0.15 mm');
  await expect(candidate).toContainText('0.20 mm');
  await beginComparison.click();

  const blocks = ['A', 'B', 'B', 'A', 'A', 'B'];
  let previousPrompts: string[] = [];
  for (const [blockIndex, condition] of blocks.entries()) {
    await test.step(`Pair ${Math.floor(blockIndex / 2) + 1}, condition ${condition}`, async () => {
      await expect(page.getByRole('heading', { name: `第 ${Math.floor(blockIndex / 2) + 1} 對 / 3` })).toBeVisible();
      await expect(page.locator('.condition')).toHaveText(`${condition} 組`);
      const confirmation = page.getByRole('button', { name: `已套用 ${condition} 組` });
      await confirmation.click();
      const pauseMs = condition === 'A' ? 2_500 : 1_000;
      const english = await completeRound(page, 'english', { pauseMs });
      if (blockIndex === 2) {
        // Reload inside a comparison block. The first round stays recorded and the driver confirmation resets.
        await page.reload();
        await expect(confirmation).toBeVisible();
        await confirmation.click();
      }
      const chinese = await completeRound(page, 'chinese', { pauseMs });
      const drill = await completeRound(page, 'drill', { extraF: condition === 'A' });
      const currentPrompts = [english, chinese, drill];
      if (blockIndex % 2 === 0) {
        for (const prompt of [english, chinese]) expect(passages).not.toContain(prompt);
        passages.push(english, chinese);
        previousPrompts = currentPrompts;
      } else {
        expect(currentPrompts).toEqual(previousPrompts);
      }
    });
  }

  await expect(page.getByRole('heading', { name: '逐鍵 RT 建議', level: 1 })).toBeVisible();
  await expect(page.locator('.keyboard .key')).toHaveCount(84);
  await expect(candidate).toContainText('實測推薦');
  await expect(candidate).toContainText('0.20 mm');
  await expect(candidate).toContainText(/3 \/ \d+/);
  await expect(candidate).toContainText(/0 \/ \d+/);
  await page.getByRole('button', { name: '用新文本複測整組' }).click();
  const holdoutPrompts: string[] = [];
  for (const condition of ['A', 'B']) {
    await expect(page.getByRole('heading', { name: '整組複測', exact: true })).toBeVisible();
    await page.getByRole('button', { name: `已套用 ${condition} 組` }).click();
    const pauseMs = condition === 'A' ? 2_500 : 1_000;
    const english = await completeRound(page, 'english', { pauseMs });
    const chinese = await completeRound(page, 'chinese', { pauseMs });
    if (condition === 'A') {
      expect(passages).not.toContain(english);
      expect(passages).not.toContain(chinese);
      holdoutPrompts.push(english, chinese);
    } else {
      expect([english, chinese]).toEqual(holdoutPrompts);
    }
  }
  await expect(page.getByRole('status').filter({ hasText: '整組已通過新文本複測。' })).toBeVisible();

  const { study, raw } = await savedStudy(page);
  expect(study.baseline.map(({ kind }) => kind)).toEqual(['english', 'english', 'chinese', 'chinese', 'drill']);
  expect(study.supplements[0].round?.promptId).toBe('v2-supplement-0');
  expect(study.trials).toHaveLength(1);
  expect(study.trials[0].targets).toEqual([{ code: 'KeyF', distance: 20, source: 'manual' }]);
  expect(study.trials[0].rounds.map(({ kind }) => kind)).toEqual(blocks.flatMap(() => ['english', 'chinese', 'drill']));
  expect(study.trials[0].rounds.map(round => round.keys.KeyF?.extra ?? 0)).toEqual(
    blocks.flatMap(condition => [0, 0, condition === 'A' ? 1 : 0]),
  );
  expect(study.validation.map(({ kind }) => kind)).toEqual(['english', 'chinese', 'english', 'chinese']);
  for (const round of [...study.baseline, ...study.trials[0].rounds, ...study.validation]) {
    expect(Object.keys(round).sort()).toEqual(['elapsedMs', 'keys', 'kind', 'promptId', 'text']);
    expect(Object.keys(round.text).sort()).toEqual(['correctPerMinute', 'errors', 'length']);
    expect(round.text.errors).toBe(round.keys.KeyF?.extra ?? 0);
  }
  expect(JSON.parse(raw)).toEqual(study);
  for (const text of [unfinishedText, supplement, ...passages, ...holdoutPrompts]) expect(raw).not.toContain(text);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([storageKey]);

  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載 CSV' }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('rt-typing-lab-results.csv');
  const path = await download.path();
  if (!path) throw new Error('CSV did not download');
  const csv = await readFile(path, 'utf8');
  const rows = csv.split('\r\n');
  expect(rows).toHaveLength(49);
  expect(rows[0]).toContain('"實體鍵","欄位","原設定"');
  expect(rows.find(row => row.startsWith('"KeyF",'))).toContain('"0.15 mm","0.20","實測推薦"');
  for (const text of [...passages, ...holdoutPrompts]) expect(csv).not.toContain(text);

  await page.getByText('F 的比較紀錄（1）').click();
  await expect(page.locator('#key-detail').getByRole('rowheader', { name: '0.20 mm' })).toBeVisible();
  await page.getByRole('button', { name: '比較 F 的相鄰值 0.19 mm' }).click();
  await expect(page.getByLabel('候選值')).toHaveValue('0.19');
  await expect(page.getByRole('rowheader', { name: 'F', exact: true }).locator('..')).toContainText('0.15 mm');
  await expect(page.getByRole('rowheader', { name: 'F', exact: true }).locator('..')).toContainText('0.19 mm');
  await expect(page.getByRole('button', { name: '開始三對比較' })).toBeEnabled();
  expect(externalRequests).toEqual([]);
});
