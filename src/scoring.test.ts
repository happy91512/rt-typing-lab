import assert from "node:assert/strict";
import test from "node:test";
import { scoreKeys, scoreText } from "./scoring.ts";
import type { Stroke } from "./scoring.ts";

function typed(key: string, time: number, repeat = false): Stroke {
  return { code: `Key${key}`, character: key.toLowerCase(), time, repeat };
}

test("counts physical-key matches and intended repeat opportunities", () => {
  const score = scoreKeys(["KeyA", "KeyA", "KeyB"], [
    { ...typed("A", 0), character: "q" },
    typed("A", 100),
    typed("B", 200),
  ]);
  assert.equal(score.errors, 0);
  assert.equal(score.matches, 3);
  assert.equal(score.keys.KeyA.opportunities, 2);
  assert.equal(score.keys.KeyA.repeatOpportunities, 1);
});

test("only scores closely spaced independent extra presses", () => {
  const target = ["KeyA", "KeyB"];
  const close = scoreKeys(target, [typed("A", 0), typed("A", 150), typed("B", 250)]);
  const late = scoreKeys(target, [typed("A", 0), typed("A", 151), typed("B", 250)]);
  const autoRepeat = scoreKeys(target, [typed("A", 0), typed("A", 100, true), typed("B", 250)]);
  assert.equal(close.errors, 1);
  assert.equal(close.keys.KeyA.extra, 1);
  assert.equal(late.errors, 1);
  assert.equal(late.keys.KeyA.extra, 0);
  assert.equal(autoRepeat.errors, 0);
  assert.equal(autoRepeat.keys.KeyA.extra, 0);
});

test("assigns a missing press in an adjacent same-key run to a repeat opportunity", () => {
  const score = scoreKeys(["KeyA", "KeyA", "KeyA", "KeyB"], [typed("A", 0), typed("B", 120)]);
  assert.equal(score.errors, 2);
  assert.equal(score.keys.KeyA.repeatOpportunities, 2);
  assert.equal(score.keys.KeyA.repeatMiss, 2);
  assert.equal(score.keys.KeyA.missed, 0);
});

test("scores ordinary omissions and substitutions separately", () => {
  const missing = scoreKeys(["KeyA", "KeyB", "KeyC"], [typed("A", 0), typed("C", 100)]);
  const substitution = scoreKeys(["KeyA", "KeyB", "KeyC"], [
    typed("A", 0), typed("D", 100), typed("C", 200),
  ]);
  assert.equal(missing.keys.KeyB.missed, 1);
  assert.equal(missing.keys.KeyB.repeatMiss, 0);
  assert.equal(substitution.keys.KeyB.substituted, 1);
  assert.equal(substitution.keys.KeyB.extra, 0);
});

test("records an adjacent swap without assigning rapid-trigger evidence", () => {
  const score = scoreKeys(["KeyA", "KeyB", "KeyC"], [
    typed("B", 0), typed("A", 30), typed("C", 50),
  ]);
  assert.equal(score.errors, 1);
  assert.equal(score.matches, 1);
  for (const code of ["KeyA", "KeyB"]) {
    assert.equal(score.keys[code].transposed, 1);
    assert.equal(score.keys[code].extra, 0);
    assert.equal(score.keys[code].repeatMiss, 0);
  }
});

test("withholds key evidence when equally good alignments disagree", () => {
  const score = scoreKeys(["KeyA", "KeyB"], [typed("B", 0), typed("C", 100)]);
  assert.equal(score.errors, 2);
  assert.equal(score.keys.KeyA.missed, 0);
  assert.equal(score.keys.KeyA.substituted, 0);
  assert.equal(score.keys.KeyB.substituted, 0);
});

test("handles empty prompts and runs", () => {
  assert.deepEqual(scoreKeys([], [typed("A", 0)]), { errors: 1, matches: 0, keys: {} });
  const score = scoreKeys(["KeyA", "KeyA"], []);
  assert.equal(score.errors, 2);
  assert.equal(score.keys.KeyA.missed, 2);
  assert.equal(score.keys.KeyA.repeatMiss, 0);
});

test("scores NFC text with Unicode code points and elapsed correct characters per minute", () => {
  assert.deepEqual(scoreText("é𠮷台", "e\u0301𠮷灣", 30_000), {
    errors: 1,
    length: 3,
    correctPerMinute: 4,
  });
  assert.equal(scoreText("甲乙", "乙甲", 30_000).errors, 2);
  assert.equal(scoreText("甲", "甲", 0).correctPerMinute, 0);
  assert.equal(scoreText("甲", "天地玄黃", 30_000).correctPerMinute, 0);
});
