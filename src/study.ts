import { z } from 'zod';
import { getBaselinePrompts, getPairPrompts, getSupplementPrompt, getValidationPrompts, typeableCodes } from './prompts.ts';
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

const target = z.object({ code: keyCode, distance, source: z.enum(['signals', 'manual', 'enable', 'travel']) });
export type Target = z.infer<typeof target>;
const studySchema = z.object({
  version: z.literal(1),
  config: configSchema,
  baseline: z.array(round).max(5),
  supplements: z.array(z.object({
    targets: z.array(keyCode).min(1).max(6),
    round: round.optional(),
  })).max(48).default([]),
  travelTargets: z.array(target).max(48).default([]),
  trials: z.array(z.object({
    targets: z.array(target).min(1).max(6),
    rounds: z.array(round).max(18),
    promptSet: z.literal('v2').optional(),
  })),
  validation: z.array(round).max(4),
});
export type Study = z.infer<typeof studySchema>;
export type Trial = Study['trials'][number];
export const storageKey = 'rt-typing-lab.study';
export const pairs = 3;
export const minimumBaselineSamples = 12;
const roundsPerPair = 6;
const order: Condition[] = ['A', 'B', 'B', 'A', 'A', 'B'];

export function newStudy(config: Config): Study {
  return { version: 1, config, baseline: [], supplements: [], travelTargets: [], trials: [], validation: [] };
}

export function restoreStudy(raw: string): Study | null {
  try {
    const data: unknown = JSON.parse(raw);
    const result = studySchema.safeParse(data);
    if (!result.success) return null;
    const study = result.data;
    const baseline = getBaselinePrompts();
    if (!study.baseline.every((entry, i) => matchesPrompt(entry, baseline[i]))) return null;
    if (new Set(study.travelTargets.map(item => item.code)).size !== study.travelTargets.length
      || study.travelTargets.some(item => !validTravelTarget(study.config, item))) return null;
    if ((study.trials.length || study.supplements.length) && study.baseline.length !== baseline.length) return null;
    if (study.supplements.some(({ targets, round }, index) =>
      new Set(targets).size !== targets.length
      || (round ? !matchesPrompt(round, getSupplementPrompt(index, targets)) : index !== study.supplements.length - 1)
    )) return null;
    if (pendingSupplement(study) && ((study.trials.at(-1)?.rounds.length ?? 18) < 18
      || (study.validation.length > 0 && study.validation.length < 4))) return null;
    if (study.trials.some((trial, i) =>
      new Set(trial.targets.map(({ code }) => code)).size !== trial.targets.length
      || trial.targets.some(({ distance: value }) => !onGrid(value, study.config.bounds))
      || (i < study.trials.length - 1 && trial.rounds.length !== 18)
      || !trial.rounds.every((entry, j) => matchesPrompt(entry, comparisonPrompt(trial, i, j)?.prompt))
    )) return null;
    if (study.validation.length && (study.trials.at(-1)?.rounds.length !== 18
      || !Object.values(mergedRecommendations(study)).some(result => result.status === 'recommended'))) return null;
    const validation = getValidationPrompts(study.trials.length, study.trials.at(-1)?.promptSet);
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
  const prompts = getPairPrompts(trialIndex * pairs + pair, trial.targets.map(({ code }) => code), trial.promptSet);
  return { prompt: prompts[roundIndex % 3], block, pair, condition };
}

export function validationPrompt(study: Study): { prompt: Prompt; condition: Condition; block: number } | null {
  const index = study.validation.length;
  if (index >= 4) return null;
  return {
    prompt: getValidationPrompts(study.trials.length, study.trials.at(-1)?.promptSet)[index % 2],
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

export function baselineKeyCounts(study: Study): Record<string, KeyCounts> {
  const supplements = study.supplements.flatMap(({ targets, round }) => round
    ? [{ ...round, keys: Object.fromEntries(Object.entries(round.keys).filter(([code]) => targets.includes(code))) }]
    : []);
  return totalKeys([...study.baseline, ...supplements]);
}

export function lowSampleKeys(counts: Record<string, KeyCounts>): string[] {
  return typeableCodes.filter(code => (counts[code]?.opportunities ?? 0) < minimumBaselineSamples)
    .sort((a, b) => (counts[a]?.opportunities ?? 0) - (counts[b]?.opportunities ?? 0));
}

export function pendingSupplement(study: Study) {
  const next = study.supplements.at(-1);
  if (!next || next.round) return null;
  return { targets: next.targets, prompt: getSupplementPrompt(study.supplements.length - 1, next.targets) };
}

export function startSupplement(study: Study, preferred?: string): boolean {
  if (study.baseline.length !== getBaselinePrompts().length || pendingSupplement(study)
    || (study.trials.at(-1)?.rounds.length ?? 18) < 18 || (study.validation.length > 0 && study.validation.length < 4)
    || study.supplements.length >= typeableCodes.length) return false;
  const queue = lowSampleKeys(baselineKeyCounts(study));
  if (preferred && queue.includes(preferred)) {
    queue.splice(queue.indexOf(preferred), 1);
    queue.unshift(preferred);
  }
  if (!queue.length) return false;
  study.supplements.push({ targets: queue.slice(0, 6) });
  return true;
}

export function finishSupplement(study: Study, round: Round): boolean {
  const next = pendingSupplement(study);
  const item = study.supplements.at(-1);
  if (!item || !next || !matchesPrompt(round, next.prompt)) return false;
  item.round = round;
  return true;
}

export function cancelSupplement(study: Study): boolean {
  if (!pendingSupplement(study)) return false;
  study.supplements.pop();
  return true;
}

function emptyCounts(): KeyCounts {
  return { opportunities: 0, repeatOpportunities: 0, extra: 0, repeatMiss: 0, missed: 0, substituted: 0, transposed: 0 };
}

function validTravelTarget(config: Config, item: Target): boolean {
  const original = settingFor(config, item.code);
  return item.source === 'travel' && original.enabled && item.distance !== original.distance
    && onGrid(item.distance, config.bounds);
}

export function recordTravelTarget(study: Study, code: string, value: number): boolean {
  const target: Target = { code, distance: value, source: 'travel' };
  if (!typeableCodes.includes(code) || !validTravelTarget(study.config, target)) return false;
  if (study.trials.some(trial => trial.targets.some(item => item.code === code && item.distance === value))) return false;
  study.travelTargets = [...study.travelTargets.filter(item => item.code !== code), target];
  return true;
}

export function proposeTargets(study: Study): Target[] {
  const tried = (item: Target) => study.trials.some(trial =>
    trial.targets.some(target => target.code === item.code && target.distance === item.distance));
  const fromTravel = study.travelTargets.filter(item => !tried(item));
  const travelCodes = new Set(fromTravel.map(target => target.code));
  const counts = baselineKeyCounts(study);
  const { bounds } = study.config;
  const fromTyping = typeableCodes.flatMap((code): Target[] => {
    const count = counts[code];
    if (!count || count.opportunities < minimumBaselineSamples || travelCodes.has(code)) return [];
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
  }).filter(item => !tried(item)).sort((a, b) =>
    (counts[b.code].extra + counts[b.code].repeatMiss + (b.source === 'enable' ? counts[b.code].missed : 0))
    - (counts[a.code].extra + counts[a.code].repeatMiss + (a.source === 'enable' ? counts[a.code].missed : 0))
  );
  return [...fromTravel, ...fromTyping].slice(0, 6);
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
  for (let i = 0; i + roundsPerPair <= trial.rounds.length; i += roundsPerPair) {
    const first = trial.rounds.slice(i, i + roundsPerPair / 2);
    const second = trial.rounds.slice(i + roundsPerPair / 2, i + roundsPerPair);
    if (!first.every((round, j) => round.promptId === second[j].promptId && round.kind === second[j].kind)) break;
    comparisons.push(order[i / 3] === 'A' ? { A: first, B: second } : { A: second, B: first });
  }
  return comparisons;
}

export function latestPairToRepeat(study: Study) {
  const last = study.trials.at(-1);
  if (!last?.rounds.length || pendingSupplement(study) || (study.validation.length > 0 && study.validation.length < 4)) return null;
  const pair = Math.floor((last.rounds.length - 1) / roundsPerPair);
  const kept = pair * roundsPerPair;
  return { pair, kept, removed: last.rounds.length - kept };
}

export function repeatLatestPair(study: Study): boolean {
  const repeat = latestPairToRepeat(study);
  const trial = study.trials.at(-1);
  if (!repeat || !trial) return false;
  trial.rounds.length = repeat.kept;
  study.validation = [];
  return true;
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
        || (entry.status === 'recommended' && (current.status !== 'recommended'
          || betterRecommendation(entry, current, settingFor(study.config, code))))) {
        result[code] = entry;
      }
    }
  }
  for (const target of proposeTargets(study)) {
    result[target.code] ??= { target, a: emptyCounts(), b: emptyCounts(), status: 'pending',
      reason: target.source === 'travel' ? '依行程試算提出，等待換值實測' : '依基準表現提出，等待換值實測' };
  }
  return result;
}

function improvement(result: Recommendation) {
  const source = result.target?.source;
  return countRtErrors(result.a, source) / result.a.opportunities - countRtErrors(result.b, source) / result.b.opportunities;
}

function betterRecommendation(candidate: Recommendation, current: Recommendation, original: Setting): boolean {
  const difference = improvement(candidate) - improvement(current);
  if (difference !== 0) return difference > 0;
  if (!original.enabled || !candidate.target || !current.target) return false;
  return Math.abs(candidate.target.distance - original.distance) < Math.abs(current.target.distance - original.distance);
}

export function refinementForKey(study: Study, code: string): Target | null {
  if (study.trials.at(-1)?.rounds.length !== 18) return null;
  const best = mergedRecommendations(study)[code];
  if (best?.status !== 'recommended' || !best.target) return null;

  const original = settingFor(study.config, code);
  const { bounds } = study.config;
  const { extra, repeatMiss, repeatOpportunities } = best.b;
  const { distance, source } = best.target;
  let direction: number;
  if (extra >= 2 && repeatMiss === 0) direction = 1;
  else if (repeatMiss >= 2 && extra === 0 && repeatOpportunities >= 24) direction = -1;
  else if (original.enabled && countRtErrors(best.b, source) === 0) direction = Math.sign(original.distance - distance);
  else return null;

  const next = distance + direction * bounds.step;
  if (!onGrid(next, bounds) || (original.enabled && next === original.distance)
    || study.trials.some(trial => trial.targets.some(target => target.code === code && target.distance === next))) return null;
  return { code, distance: next, source: original.enabled ? 'signals' : 'enable' };
}
