import { z } from 'zod';
import { getBaselinePrompts, getPairPrompts, getValidationPrompts, typeableCodes } from './prompts.ts';
import type { Prompt } from './prompts.ts';
import type { KeyCounts } from './scoring.ts';

const keyCode = z.enum(typeableCodes);
const distance = z.number().min(1).max(10000).int();
const setting = z.object({ enabled: z.boolean(), distance });
const amount = z.number().finite().nonnegative();
const boundsSchema = z.object({ min: distance, max: distance, step: distance });
type Bounds = z.infer<typeof boundsSchema>;
const keyCounts = z.object({
  opportunities: amount, repeatOpportunities: amount, extra: amount,
  repeatMiss: amount, missed: amount, substituted: amount, transposed: amount,
});

export const configSchema = z.object({
  field: z.enum(['linked', 'press', 'release']),
  standard: setting,
  overrides: z.partialRecord(keyCode, setting),
  bounds: boundsSchema,
  slotA: z.enum(['1', '2', '3']),
  slotB: z.enum(['same', '1', '2', '3']),
}).refine(({ slotA, slotB, bounds, standard, overrides }) =>
  (slotB === 'same' || slotA !== slotB)
  && bounds.min <= bounds.max
  && [standard, ...Object.values(overrides)].every(value => !value || onGrid(value.distance, bounds))
);

export type Config = z.infer<typeof configSchema>;
export type Setting = z.infer<typeof setting>;
export type Condition = 'A' | 'B';
export const defaultConfig: Config = {
  field: 'linked', standard: { enabled: true, distance: 15 }, overrides: {},
  bounds: { min: 1, max: 340, step: 1 }, slotA: '1', slotB: 'same',
};

const round = z.object({
  promptId: z.string(),
  kind: z.enum(['english', 'chinese', 'drill']),
  elapsedMs: amount.positive(),
  text: z.object({ errors: amount, length: amount, correctPerMinute: amount }),
  keys: z.record(z.string(), keyCounts),
});
export type Round = z.infer<typeof round>;

const target = z.object({ code: keyCode, distance, source: z.enum(['signals', 'manual', 'enable']) });
export type Target = z.infer<typeof target>;
const studySchema = z.object({
  version: z.literal(1),
  config: configSchema,
  baseline: z.array(round).max(5),
  trials: z.array(z.object({
    targets: z.array(target).min(1).max(6),
    rounds: z.array(round).max(18),
  })),
  validation: z.array(round).max(4),
});
export type Study = z.infer<typeof studySchema>;
export type Trial = Study['trials'][number];
export const storageKey = 'rt-typing-lab.study';
export const pairs = 3;
const order: Condition[] = ['A', 'B', 'B', 'A', 'A', 'B'];

export function newStudy(config: Config): Study {
  return { version: 1, config, baseline: [], trials: [], validation: [] };
}

export function restoreStudy(raw: string): Study | null {
  try {
    const data: unknown = JSON.parse(raw);
    const result = studySchema.safeParse(data);
    if (!result.success) return null;
    const study = result.data;
    const baseline = getBaselinePrompts();
    if (!study.baseline.every((entry, i) => matchesPrompt(entry, baseline[i]))) return null;
    if (study.trials.length && study.baseline.length !== baseline.length) return null;
    if (study.trials.some((trial, i) =>
      new Set(trial.targets.map(({ code }) => code)).size !== trial.targets.length
      || trial.targets.some(({ distance: value }) => !onGrid(value, study.config.bounds))
      || (i < study.trials.length - 1 && trial.rounds.length !== 18)
      || !trial.rounds.every((entry, j) => matchesPrompt(entry, comparisonPrompt(trial, i, j)?.prompt))
    )) return null;
    if (study.validation.length && (study.trials.at(-1)?.rounds.length !== 18
      || !Object.values(mergedRecommendations(study)).some(result => result.status === 'recommended'))) return null;
    const validation = getValidationPrompts(study.trials.length);
    if (!study.validation.every((entry, i) => matchesPrompt(entry, validation[i % 2]))) return null;
    return study;
  } catch {
    return null;
  }
}

function matchesPrompt(round: Round, prompt: Prompt | undefined): boolean {
  return round.promptId === prompt?.id && round.kind === prompt.kind;
}

export function onGrid(value: number, { min, max, step }: Bounds): boolean {
  return Number.isInteger(value) && value >= min && value <= max && (value - min) % step === 0;
}

export function mm(value: number): string {
  return (value / 100).toFixed(2);
}

export function settingFor(config: Config, code: string): Setting {
  return config.overrides[code] ?? config.standard;
}

export function comparisonPrompt(trial: Trial, trialIndex: number, roundIndex = trial.rounds.length) {
  const block = Math.floor(roundIndex / 3);
  const condition = order[block];
  if (!condition) return null;
  const pair = Math.floor(block / 2);
  const prompts = getPairPrompts(trialIndex * pairs + pair, trial.targets.map(({ code }) => code));
  return { prompt: prompts[roundIndex % 3], block, pair, condition };
}

export function validationPrompt(study: Study): { prompt: Prompt; condition: Condition; block: number } | null {
  const index = study.validation.length;
  if (index >= 4) return null;
  return {
    prompt: getValidationPrompts(study.trials.length)[index % 2],
    condition: index < 2 ? 'A' : 'B',
    block: Math.floor(index / 2),
  };
}

export function totalKeys(rounds: readonly Round[]): Record<string, KeyCounts> {
  const keys: Record<string, KeyCounts> = Object.create(null);
  for (const round of rounds) {
    for (const [code, count] of Object.entries(round.keys)) {
      const entry = keys[code] ??= emptyCounts();
      entry.opportunities += count.opportunities;
      entry.repeatOpportunities += count.repeatOpportunities;
      entry.extra += count.extra;
      entry.repeatMiss += count.repeatMiss;
      entry.missed += count.missed;
      entry.substituted += count.substituted;
      entry.transposed += count.transposed;
    }
  }
  return keys;
}

function emptyCounts(): KeyCounts {
  return { opportunities: 0, repeatOpportunities: 0, extra: 0, repeatMiss: 0, missed: 0, substituted: 0, transposed: 0 };
}

export function proposeTargets(study: Study): Target[] {
  const counts = totalKeys(study.baseline);
  const { bounds } = study.config;
  return typeableCodes.flatMap((code): Target[] => {
    const count = counts[code];
    if (!count || count.opportunities < 12) return [];
    const original = settingFor(study.config, code);
    if (!original.enabled) {
      return count.extra + count.repeatMiss + count.missed >= 2
        ? [{ code, distance: original.distance, source: 'enable' }] : [];
    }
    const up = count.extra >= 2;
    const down = count.repeatMiss >= 2;
    if (up === down) return [];
    const delta = bounds.step * Math.max(1, Math.round(5 / bounds.step));
    const value = original.distance + (up ? delta : -delta);
    return onGrid(value, bounds) ? [{ code, distance: value, source: 'signals' }] : [];
  }).sort((a, b) =>
    (counts[b.code].extra + counts[b.code].repeatMiss + (b.source === 'enable' ? counts[b.code].missed : 0))
    - (counts[a.code].extra + counts[a.code].repeatMiss + (a.source === 'enable' ? counts[a.code].missed : 0))
  ).slice(0, 6);
}

export type TextSummary = { errors: number; characters: number; rate: number; speed: number };
export function summarizeText(rounds: readonly Round[], kind: 'english' | 'chinese'): TextSummary {
  const totals = rounds.filter(round => round.kind === kind).reduce((total, round) => ({
    errors: total.errors + round.text.errors,
    characters: total.characters + round.text.length,
    elapsedMs: total.elapsedMs + round.elapsedMs,
    correct: total.correct + round.text.correctPerMinute * round.elapsedMs / 60_000,
  }), { errors: 0, characters: 0, elapsedMs: 0, correct: 0 });
  return {
    errors: totals.errors, characters: totals.characters,
    rate: totals.characters ? totals.errors / totals.characters : 0,
    speed: totals.elapsedMs ? totals.correct * 60_000 / totals.elapsedMs / (kind === 'english' ? 5 : 1) : 0,
  };
}

export function passesTextGuard(original: readonly Round[], candidate: readonly Round[]): boolean {
  return (['english', 'chinese'] as const).every(kind => {
    const a = summarizeText(original, kind);
    const b = summarizeText(candidate, kind);
    return a.characters > 0 && b.characters > 0 && b.speed >= a.speed * 0.9 && b.rate <= a.rate + 0.020000001;
  });
}

export function completePairs(trial: Trial): Record<Condition, Round[]>[] {
  const comparisons: Record<Condition, Round[]>[] = [];
  for (let i = 0; i + 5 < trial.rounds.length; i += 6) {
    const first = trial.rounds.slice(i, i + 3);
    const second = trial.rounds.slice(i + 3, i + 6);
    if (!first.every((round, j) => round.promptId === second[j].promptId && round.kind === second[j].kind)) break;
    comparisons.push(order[i / 3] === 'A' ? { A: first, B: second } : { A: second, B: first });
  }
  return comparisons;
}

export type Recommendation = {
  status: 'recommended' | 'keep' | 'pending' | 'insufficient';
  target: Target | undefined;
  a: KeyCounts;
  b: KeyCounts;
  reason: string;
};

export function countRtErrors(count: KeyCounts, source?: Target['source']): number {
  return count.extra + count.repeatMiss + (source === 'enable' ? count.missed : 0);
}

export function trialResults(trial: Trial): Record<string, Recommendation> {
  const paired = completePairs(trial);
  const original = paired.flatMap(pair => pair.A);
  const candidate = paired.flatMap(pair => pair.B);
  const textOK = passesTextGuard(original, candidate);
  const aCounts = totalKeys(original);
  const bCounts = totalKeys(candidate);
  const perPair = paired.map(pair => ({ A: totalKeys(pair.A), B: totalKeys(pair.B) }));
  return Object.fromEntries(trial.targets.map(target => {
    const { code } = target;
    const a = aCounts[code] ?? emptyCounts();
    const b = bCounts[code] ?? emptyCounts();
    const row = { target, a, b };
    if (paired.length < pairs) return [code, { ...row, status: 'pending', reason: '等待完成三對比較' }];
    const repeatSignal = a.repeatMiss + b.repeatMiss > 0;
    if (a.opportunities < 24 || b.opportunities < 24 || (repeatSignal && Math.min(a.repeatOpportunities, b.repeatOpportunities) < 24 && a.extra <= b.extra)) {
      return [code, { ...row, status: 'insufficient', reason: '需要更多對應的按鍵樣本' }];
    }
    const errors = (count: KeyCounts) => countRtErrors(count, target.source);
    const reductions = perPair.map(pair => errors(pair.A[code] ?? emptyCounts()) - errors(pair.B[code] ?? emptyCounts()));
    const consistent = reductions.every(value => value >= 0) && reductions.filter(value => value > 0).length >= 2;
    if (!textOK) return [code, { ...row, status: 'keep', reason: '候選組未通過中英文速度或錯字率門檻' }];
    if (b.repeatMiss > a.repeatMiss || b.extra > a.extra
      || (target.source === 'enable' && b.missed > a.missed) || errors(a) - errors(b) < 2 || !consistent) {
      return [code, { ...row, status: 'keep', reason: '三對測試的改善不夠一致' }];
    }
    return [code, { ...row, status: 'recommended', reason: '多輪錯誤減少，且通過中英文門檻' }];
  }));
}

export function mergedRecommendations(study: Study): Record<string, Recommendation> {
  const result: Record<string, Recommendation> = Object.create(null);
  for (const trial of study.trials) {
    for (const [code, entry] of Object.entries(trialResults(trial))) {
      const current = result[code];
      if (!current || (current.status !== 'recommended' && entry.status === 'keep')
        || (entry.status === 'recommended' && (current.status !== 'recommended' || improvement(entry) > improvement(current)))) {
        result[code] = entry;
      }
    }
  }
  for (const target of proposeTargets(study)) {
    result[target.code] ??= { target, a: emptyCounts(), b: emptyCounts(), status: 'pending', reason: '依基準表現提出，等待換值實測' };
  }
  return result;
}

function improvement(result: Recommendation) {
  const source = result.target?.source;
  return countRtErrors(result.a, source) / result.a.opportunities - countRtErrors(result.b, source) / result.b.opportunities;
}
