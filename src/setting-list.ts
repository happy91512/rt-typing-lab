import { typeableCodes } from './prompts.ts';
import { mm, passesTextGuard, settingFor } from './study.ts';
import type { Config, Recommendation, Setting, Study } from './study.ts';

export type SettingRow = { code: string; original: Setting; candidate: Setting; recommended: boolean };
export type SettingList = {
  slotA: Config['slotA'];
  slotB: Config['slotB'];
  validation: 'pending' | 'passed' | 'failed';
  rows: SettingRow[];
};

export function settingList(study: Study, results: Record<string, Recommendation>): SettingList | null {
  const { config, trials, validation } = study;
  const tested = new Set(trials.flatMap(trial => trial.targets.map(target => target.code)));
  if (config.slotB !== 'same') Object.keys(config.overrides).forEach(code => tested.add(code));
  const rows = typeableCodes.flatMap((code): SettingRow[] => {
    const original = settingFor(config, code);
    const result = results[code];
    if (result?.status === 'recommended' && result.target) {
      return [{ code, original, candidate: { enabled: true, distance: result.target.distance }, recommended: true }];
    }
    return tested.has(code) ? [{ code, original, candidate: original, recommended: false }] : [];
  });
  if (!rows.some(row => row.recommended)) return null;
  const status = validation.length < 4 ? 'pending' : passesTextGuard(validation.slice(0, 2), validation.slice(2)) ? 'passed' : 'failed';
  return { slotA: config.slotA, slotB: config.slotB, validation: status, rows };
}

export function settingText(setting: Setting): string {
  return setting.enabled ? `${mm(setting.distance)} mm` : '關閉 RT';
}

export function validationText(status: SettingList['validation']): string {
  switch (status) {
    case 'pending': return '整組尚待新文本複測';
    case 'passed': return '整組已通過新文本複測';
    case 'failed': return '整組需複測';
  }
}

export function formatSettingList(
  list: SettingList, field: string, keyLabel: (code: string) => string, defaultSetting: Setting,
): string {
  const slot = list.slotB === 'same' ? `在原槽位 ${list.slotA} 依清單換值` : `以 A 槽為基準建立 B 槽 ${list.slotB}`;
  return [
    'RT 打字實驗室｜官方驅動套用清單',
    `調整欄位　${field}`,
    `整組狀態　${validationText(list.validation)}`,
    `原設定槽位　${list.slotA}`,
    `候選設定　${slot}`,
    list.slotB === 'same' ? '未列出的鍵維持 A 的設定。' : `未列出的鍵沿用全鍵預設 ${settingText(defaultSetting)}。`,
    '套用時請固定首次觸發點、死區、軸體和未測的 RT 欄位。',
    '還原時依 A 欄核對原槽；若 A 槽未改動，切回即可。',
    '',
    '鍵\tA 原設定\tB 套用值\t依據',
    ...list.rows.map(row => [
      keyLabel(row.code), settingText(row.original), settingText(row.candidate), row.recommended ? '逐鍵實測推薦' : '沿用 A 原設定',
    ].join('\t')),
    '',
  ].join('\r\n');
}
