import assert from 'node:assert/strict';
import test from 'node:test';
import { getBaselinePrompts } from './prompts.ts';
import type { Prompt } from './prompts.ts';
import type { KeyCounts } from './scoring.ts';
import {
  comparisonPrompt, completePairs, defaultConfig, mergedRecommendations, newStudy, passesTextGuard, proposeTargets,
  recordTravelTarget, refinementForKey, restoreStudy, trialResults, validationPrompt,
} from './study.ts';
import type { Condition, Round, Study, Trial } from './study.ts';

const targetCode = 'KeyE';

function counts(overrides: Partial<KeyCounts>): KeyCounts {
  return {
    opportunities: 0, repeatOpportunities: 0, extra: 0, repeatMiss: 0,
    missed: 0, substituted: 0, transposed: 0, ...overrides,
  };
}

function makeRound(prompt: Prompt, keys: Round['keys'] = {}): Round {
  const length = [...prompt.text].length;
  return {
    promptId: prompt.id,
    kind: prompt.kind,
    elapsedMs: 60_000,
    text: { errors: 0, length, correctPerMinute: length },
    keys,
  };
}

function makeTrial(
  countFor: (condition: Condition, pair: number) => KeyCounts =
    condition => counts({ opportunities: 10, extra: condition === 'A' ? 1 : 0 }),
): Trial {
  const trial: Trial = { targets: [{ code: targetCode, distance: 20, source: 'signals' }], rounds: [] };
  for (let next = comparisonPrompt(trial, 0); next; next = comparisonPrompt(trial, 0)) {
    const { prompt, condition, pair } = next;
    const keys: Round['keys'] = prompt.kind === 'drill' ? { [targetCode]: countFor(condition, pair) } : {};
    trial.rounds.push(makeRound(prompt, keys));
  }
  return trial;
}

test('pairs identical prompts in AB, BA, AB order and recommends a consistent improvement', () => {
  const trial = makeTrial();
  const startOfBlocks = [0, 3, 6, 9, 12, 15];
  assert.deepEqual(startOfBlocks.map(index => comparisonPrompt(trial, 0, index)?.condition),
    ['A', 'B', 'B', 'A', 'A', 'B']);
  const paired = completePairs(trial);
  assert.equal(paired.length, 3);
  for (const { A, B } of paired) {
    assert.deepEqual(A.map(round => round.promptId), B.map(round => round.promptId));
    assert.equal(A[2].keys[targetCode].extra, 1);
    assert.equal(B[2].keys[targetCode].extra, 0);
  }
  const recommendation = trialResults(trial)[targetCode];
  assert.equal(recommendation.status, 'recommended');
  assert.equal(recommendation.a.extra, 3);
  assert.equal(recommendation.b.extra, 0);
});

test('waits for three complete pairs and enough opportunities in both conditions', () => {
  const trial = makeTrial();
  const unfinished = { ...trial, rounds: trial.rounds.slice(0, -1) };
  assert.equal(completePairs(unfinished).length, 2);
  assert.equal(trialResults(unfinished)[targetCode].status, 'pending');

  const rareKey = makeTrial(condition => counts({
    opportunities: condition === 'A' ? 10 : 7, extra: condition === 'A' ? 1 : 0,
  }));
  assert.equal(trialResults(rareKey)[targetCode].status, 'insufficient');

  const rareRepeat = makeTrial(condition => counts({
    opportunities: 10, repeatOpportunities: 7, repeatMiss: condition === 'A' ? 1 : 0,
  }));
  assert.equal(trialResults(rareRepeat)[targetCode].status, 'insufficient');
});

test('keeps A when one pair regresses despite an overall improvement', () => {
  const trial = makeTrial((condition, pair) => counts({
    opportunities: 10,
    extra: condition === 'A' ? 2 : Number(pair === 1) * 3,
  }));
  const recommendation = trialResults(trial)[targetCode];
  assert.equal(recommendation.a.extra - recommendation.b.extra, 3);
  assert.equal(recommendation.status, 'keep');
});

test('requires both languages to pass the speed and error-rate thresholds', () => {
  const trial = makeTrial();
  const { A: original, B: candidate } = completePairs(trial)[0];
  const atThreshold = candidate.map(round => ({
    ...round, text: { errors: 2, length: 100, correctPerMinute: round.text.correctPerMinute * 0.9 },
  }));
  assert.equal(passesTextGuard(original, atThreshold), true);
  const slowEnglish = candidate.map(round => round.kind === 'english'
    ? { ...round, text: { ...round.text, correctPerMinute: round.text.correctPerMinute * 0.89 } }
    : round);
  const inaccurateChinese = candidate.map(round => round.kind === 'chinese'
    ? { ...round, text: { ...round.text, errors: 3, length: 100 } }
    : round);
  assert.equal(passesTextGuard(original, slowEnglish), false);
  assert.equal(passesTextGuard(original, inaccurateChinese), false);
  assert.equal(passesTextGuard(original, candidate.filter(round => round.kind !== 'chinese')), false);
});

test('proposes enabling baseline OFF at its recorded distance only with enough evidence', () => {
  const study = newStudy({
    ...defaultConfig,
    overrides: {
      [targetCode]: { enabled: false, distance: 31 },
      KeyD: { enabled: false, distance: 31 },
    },
  });
  study.baseline = [makeRound(getBaselinePrompts()[0], {
    [targetCode]: counts({ opportunities: 12, missed: 2 }),
    KeyD: counts({ opportunities: 11, missed: 2 }),
    KeyF: counts({ opportunities: 12, missed: 2 }),
  })];
  assert.deepEqual(proposeTargets(study), [{ code: targetCode, distance: 31, source: 'enable' }]);
});

test('chooses the next lower candidate for repeated misses and leaves conflicting signals pending', () => {
  const study = newStudy(defaultConfig);
  study.baseline = [makeRound(getBaselinePrompts()[0], {
    [targetCode]: counts({ opportunities: 12, repeatOpportunities: 3, repeatMiss: 2 }),
    KeyF: counts({ opportunities: 12, repeatOpportunities: 3, repeatMiss: 2, extra: 2 }),
  })];
  assert.deepEqual(proposeTargets(study), [{ code: targetCode, distance: 10, source: 'signals' }]);
});

test('preserves the best tested value after trying less effective settings', () => {
  const study = newStudy(defaultConfig);
  const best = makeTrial(condition => counts({ opportunities: 10, extra: condition === 'A' ? 3 : 0 }));
  const weaker = makeTrial();
  weaker.targets[0].distance = 25;
  const losing = makeTrial(() => counts({ opportunities: 10 }));
  losing.targets[0].distance = 30;
  study.trials = [best, weaker, losing];
  assert.equal(mergedRecommendations(study)[targetCode].target?.distance, 20);
});

test('proposes one driver step toward the original when a winning value removed all errors', () => {
  const study = newStudy(defaultConfig);
  study.trials = [makeTrial()];
  assert.equal(refinementForKey(study, targetCode)?.distance, 19);
  assert.equal(refinementForKey(study, 'KeyF'), null);
  const alreadyTried = makeTrial(() => counts({ opportunities: 10 }));
  alreadyTried.targets[0].distance = 19;
  study.trials.push(alreadyTried);
  assert.equal(refinementForKey(study, targetCode), null);
  assert.equal(mergedRecommendations(study)[targetCode].target?.distance, 20);
});

test('prefers the smaller adjustment when both recommendations have the same measured improvement', () => {
  const study = newStudy(defaultConfig);
  const closer = makeTrial();
  closer.targets[0].distance = 19;
  study.trials = [makeTrial(), closer];
  assert.equal(mergedRecommendations(study)[targetCode].target?.distance, 19);
});

test('uses residual errors and driver increments to choose a follow-up', () => {
  const study = newStudy({ ...defaultConfig, bounds: { min: 5, max: 25, step: 5 } });
  study.trials = [makeTrial(condition => counts({ opportunities: 10, extra: condition === 'A' ? 2 : 1 }))];
  assert.equal(refinementForKey(study, targetCode)?.distance, 25);
  study.config.bounds.max = 20;
  assert.equal(refinementForKey(study, targetCode), null);
});

test('waits for complete comparisons and keeps RT off in the original condition', () => {
  const study = newStudy({ ...defaultConfig, standard: { ...defaultConfig.standard, enabled: false } });
  const trial = makeTrial(condition => counts({ opportunities: 10, missed: condition === 'A' ? 2 : 1 }));
  trial.targets[0].source = 'enable';
  study.trials = [trial];
  assert.equal(refinementForKey(study, targetCode), null);
  trial.targets[0].source = 'signals';
  study.config.standard.enabled = true;
  study.trials = [makeTrial()];
  study.trials.push({ ...makeTrial(), rounds: [] });
  assert.equal(refinementForKey(study, targetCode), null);
});

function makeStoredStudy(): Study {
  const study = newStudy(defaultConfig);
  study.baseline = getBaselinePrompts().map(prompt => makeRound(prompt));
  study.trials = [makeTrial()];
  for (let next = validationPrompt(study); next; next = validationPrompt(study)) {
    study.validation.push(makeRound(next.prompt));
  }
  return study;
}

test('restores a study with generated prompt IDs at every stage', () => {
  const study = makeStoredStudy();
  assert.deepEqual(restoreStudy(JSON.stringify(study)), study);
});

test('resumes old studies and keeps travel estimates separate from measured recommendations', () => {
  const { travelTargets: _, ...older } = newStudy(defaultConfig);
  const study = restoreStudy(JSON.stringify(older))!;
  assert.deepEqual(study.travelTargets, []);
  assert.equal(recordTravelTarget(study, 'Escape', 17), false);
  assert.equal(recordTravelTarget(study, targetCode, 15), false);
  assert.equal(recordTravelTarget(study, targetCode, 17), true);
  assert.equal(mergedRecommendations(study)[targetCode].status, 'pending');
  assert.equal(proposeTargets(study)[0]?.source, 'travel');
  assert.deepEqual(restoreStudy(JSON.stringify(study))?.travelTargets, study.travelTargets);

  study.trials = [makeTrial()];
  assert.equal(mergedRecommendations(study)[targetCode].target?.distance, 20);
  assert.equal(recordTravelTarget(study, targetCode, 20), false);
  assert.equal(proposeTargets(study)[0]?.distance, 17);
});

const stages: Record<string, (study: Study) => Round[]> = {
  baseline: study => study.baseline,
  comparison: study => study.trials[0].rounds,
  validation: study => study.validation,
};

for (const [stage, selectRounds] of Object.entries(stages)) {
  test(`rejects saved ${stage} rounds with a mismatched prompt ID or kind`, () => {
    const study = makeStoredStudy();
    const rounds = selectRounds(study);
    const [first, second] = rounds;
    rounds[0] = { ...first, promptId: second.promptId };
    assert.ok(restoreStudy(JSON.stringify(study)) === null, 'accepted a wrong prompt ID');
    rounds[0] = { ...first, kind: second.kind === first.kind ? 'drill' : second.kind };
    assert.ok(restoreStudy(JSON.stringify(study)) === null, 'accepted a wrong prompt kind');
  });
}
