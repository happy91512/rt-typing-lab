export type KeyCounts = {
  opportunities: number;
  repeatOpportunities: number;
  extra: number;
  repeatMiss: number;
  missed: number;
  substituted: number;
  transposed: number;
};

export type Stroke = {
  code: string;
  character: string;
  time: number;
  repeat?: boolean;
};

type ErrorCount = Exclude<keyof KeyCounts, "opportunities" | "repeatOpportunities">;
type Attribution = { code: string; count: ErrorCount };
type Step =
  | { kind: "match"; target: number; typed: number }
  | { kind: "edit"; target: number; typed: number; attributions: Attribution[] };

const EXTRA_INTERVAL_MS = 150;

function emptyKeyCounts(): KeyCounts {
  return {
    opportunities: 0,
    repeatOpportunities: 0,
    extra: 0,
    repeatMiss: 0,
    missed: 0,
    substituted: 0,
    transposed: 0,
  };
}

export function scoreKeys(expected: readonly string[], strokes: readonly Stroke[]): {
  keys: Record<string, KeyCounts>;
  errors: number;
  matches: number;
} {
  const typed = strokes.filter((stroke) => !stroke.repeat);
  const counts = new Map<string, KeyCounts>();
  for (const [index, code] of expected.entries()) {
    const key = counts.get(code) ?? emptyKeyCounts();
    key.opportunities += 1;
    if (expected[index - 1] === code) key.repeatOpportunities += 1;
    counts.set(code, key);
  }

  const distance = Array.from({ length: expected.length + 1 }, () =>
    new Uint32Array(typed.length + 1),
  );
  const optimal = Array.from({ length: expected.length + 1 }, () =>
    new Map<number, Step[]>(),
  );

  function steps(target: number, actual: number): Step[] {
    const targetCode = expected[target];
    const actualStroke = typed[actual];
    const result: Step[] = [];

    if (targetCode !== undefined && actualStroke !== undefined) {
      if (targetCode === actualStroke.code) {
        result.push({ kind: "match", target: target + 1, typed: actual + 1 });
      } else {
        const nextTarget = expected[target + 1];
        if (nextTarget === actualStroke.code && typed[actual + 1]?.code === targetCode) {
          result.push({
            kind: "edit", target: target + 2, typed: actual + 2,
            attributions: [
              { code: targetCode, count: "transposed" },
              { code: nextTarget, count: "transposed" },
            ],
          });
        }
        result.push({
          kind: "edit", target: target + 1, typed: actual + 1,
          attributions: [{ code: targetCode, count: "substituted" }],
        });
      }
    }

    if (targetCode !== undefined) {
      const repeats =
        (expected[target - 1] === targetCode && typed[actual - 1]?.code === targetCode) ||
        (expected[target + 1] === targetCode && actualStroke?.code === targetCode);
      result.push({
        kind: "edit", target: target + 1, typed: actual,
        attributions: [{ code: targetCode, count: repeats ? "repeatMiss" : "missed" }],
      });
    }

    if (actualStroke !== undefined) {
      const code = actualStroke.code;
      const previousStroke = typed[actual - 1];
      const nextStroke = typed[actual + 1];
      const followsSameKey = expected[target - 1] === code && previousStroke?.code === code &&
        Math.abs(actualStroke.time - previousStroke.time) <= EXTRA_INTERVAL_MS;
      const precedesSameKey = targetCode === code && nextStroke?.code === code &&
        Math.abs(nextStroke.time - actualStroke.time) <= EXTRA_INTERVAL_MS;
      result.push({
        kind: "edit", target, typed: actual + 1,
        attributions: followsSameKey || precedesSameKey ? [{ code, count: "extra" }] : [],
      });
    }
    return result;
  }

  for (let target = expected.length; target >= 0; target -= 1) {
    for (let actual = typed.length; actual >= 0; actual -= 1) {
      if (target === expected.length && actual === typed.length) continue;
      const options = steps(target, actual);
      const costs = options.map((step) =>
        distance[step.target][step.typed] + Number(step.kind === "edit"),
      );
      const minimum = Math.min(...costs);
      distance[target][actual] = minimum;
      optimal[target].set(actual, options.filter((_, index) => costs[index] === minimum));
    }
  }

  let matches = 0;
  const candidates = new Map<string, Set<ErrorCount>>();
  let target = 0;
  let actual = 0;
  for (;;) {
    const step = optimal[target].get(actual)?.[0];
    if (!step) break;
    if (step.kind === "match") {
      matches += 1;
    } else {
      for (const { code, count } of step.attributions) {
        const categories = candidates.get(code) ?? new Set<ErrorCount>();
        categories.add(count);
        candidates.set(code, categories);
      }
    }
    target = step.target;
    actual = step.typed;
  }

  // Keep only evidence shared by every minimum-cost alignment.
  for (const [code, categories] of candidates) {
    const key = counts.get(code) ?? emptyKeyCounts();
    for (const count of categories) {
      const minimumCounts = Array.from({ length: expected.length + 1 }, () =>
        new Uint32Array(typed.length + 1),
      );
      for (let target = expected.length; target >= 0; target -= 1) {
        for (let actual = typed.length; actual >= 0; actual -= 1) {
          const options = optimal[target].get(actual);
          if (!options) continue;
          minimumCounts[target][actual] = Math.min(...options.map((step) => {
            const occurrence = step.kind === "edit" &&
              step.attributions.some((item) => item.code === code && item.count === count);
            return minimumCounts[step.target][step.typed] + Number(occurrence);
          }));
        }
      }
      key[count] = minimumCounts[0][0];
    }
    counts.set(code, key);
  }

  return { keys: Object.fromEntries(counts), errors: distance[0][0], matches };
}

export function scoreText(expected: string, actual: string, elapsedMs: number): {
  errors: number;
  length: number;
  correctPerMinute: number;
} {
  const target = Array.from(expected.normalize("NFC"));
  const typed = Array.from(actual.normalize("NFC"));
  let previous = Array.from({ length: typed.length + 1 }, (_, index) => index);

  for (const [index, character] of target.entries()) {
    const row = [index + 1];
    for (const [typedIndex, typedCharacter] of typed.entries()) {
      row.push(Math.min(
        previous[typedIndex + 1] + 1,
        row[typedIndex] + 1,
        previous[typedIndex] + Number(character !== typedCharacter),
      ));
    }
    previous = row;
  }

  const errors = previous[typed.length];
  const correct = Math.max(0, target.length - errors);
  return {
    errors,
    length: target.length,
    correctPerMinute: elapsedMs > 0 ? correct * 60_000 / elapsedMs : 0,
  };
}
