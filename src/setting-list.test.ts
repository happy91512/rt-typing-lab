import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSettingList, settingList } from './setting-list.ts';
import { defaultConfig, newStudy } from './study.ts';
import type { Recommendation, Round } from './study.ts';

const counts = { opportunities: 25, repeatOpportunities: 8, extra: 0, repeatMiss: 0, missed: 0, substituted: 0, transposed: 0 };
const recommended: Recommendation = {
  status: 'recommended', target: { code: 'KeyF', distance: 20, source: 'manual' },
  a: { ...counts, extra: 3 }, b: counts, reason: 'fixture',
};

function validationRound(kind: Round['kind'], errors = 0): Round {
  return {
    promptId: kind, kind, elapsedMs: 3000, text: { errors, length: 20, correctPerMinute: 80 },
    keys: {},
  };
}

test('restores losing settings and carries original overrides into a different B slot', () => {
  const study = newStudy({
    ...defaultConfig, slotB: '2', field: 'release',
    overrides: { KeyF: { enabled: false, distance: 15 }, KeyG: { enabled: true, distance: 25 } },
  });
  study.trials.push({ targets: [{ code: 'KeyH', distance: 10, source: 'manual' }], rounds: [] });
  const plan = settingList(study, { KeyF: recommended })!;
  assert.equal(plan.validation, 'pending');
  assert.deepEqual(plan.rows.map(row => [row.code, row.original.enabled, row.candidate.distance, row.recommended]), [
    ['KeyF', false, 20, true], ['KeyG', true, 25, false], ['KeyH', true, 15, false],
  ]);
  const text = formatSettingList(plan, '抬起靈敏度', code => code.slice(3), study.config.standard);
  assert.match(text, /整組尚待新文本複測/);
  assert.match(text, /B 槽 2/);
  assert.match(text, /F\t關閉 RT\t0.20 mm\t逐鍵實測推薦/);
  assert.match(text, /H\t0.15 mm\t0.15 mm\t沿用 A 原設定/);
});

test('reflects combined validation and leaves untouched same-slot overrides out of the list', () => {
  const study = newStudy({ ...defaultConfig, overrides: { KeyG: { enabled: true, distance: 25 } } });
  const a = [validationRound('english'), validationRound('chinese')];
  study.validation = [...a, ...a];
  assert.equal(settingList(study, {}), null);
  const plan = settingList(study, { KeyF: recommended })!;
  assert.equal(plan.validation, 'passed');
  assert.deepEqual(plan.rows.map(row => row.code), ['KeyF']);
  assert.match(formatSettingList(plan, '共同值', code => code, study.config.standard), /未列出的鍵維持 A 的設定/);

  study.validation = [...a, validationRound('english'), validationRound('chinese', 2)];
  assert.equal(settingList(study, { KeyF: recommended })?.validation, 'failed');
});
