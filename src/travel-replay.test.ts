import assert from 'node:assert/strict';
import test from 'node:test';
import { assessTravel } from './travel-replay.ts';
import type { ReplaySettings, TravelAttempt } from './travel-replay.ts';

const settings: ReplaySettings = {
  actuation: 100, top: 26, bottom: 25, full: 340, press: 15, release: 15,
  field: 'linked', bounds: { min: 1, max: 340, step: 1 },
};

function attempt(expected: 1 | 2, movements: number[], states: boolean[], interval = 15): TravelAttempt {
  const samples = movements.map((depth, index) => ({
    position: 43, rawTravel: depth * 10, pressed: states[index], receivedAt: index * interval,
  }));
  return {
    expected, samples,
    edges: samples.filter((sample, index) => index > 0 && sample.pressed !== states[index - 1])
      .map(({ pressed, receivedAt }) => ({ pressed, receivedAt })),
  };
}

const bounce = (interval?: number) => attempt(1,
  [0, 100, 140, 124, 140, 140, 0], [false, true, true, false, true, true, false], interval);
const deliberate = (interval?: number) => attempt(2,
  [0, 100, 140, 110, 140, 160, 0], [false, true, true, false, true, true, false], interval);
const single = () => attempt(1, [0, 100, 140, 0], [false, true, true, false]);

test('shows the closest candidate that suppresses rebound and preserves intentional doubles', () => {
  const attempts = [bounce(), deliberate(), bounce(), deliberate(), bounce(), deliberate()];
  assert.deepEqual(assessTravel(attempts, settings), {
    status: 'candidate', distance: 17, originalErrors: 3, candidateErrors: 0,
  });
});

test('holds the other field stable and observes bounds', () => {
  const attempts = [bounce(), deliberate(), bounce(), deliberate(), bounce(), deliberate()];
  for (const field of ['press', 'release'] as const) {
    assert.equal(assessTravel(attempts, { ...settings, field }).status, 'candidate');
  }
  assert.equal(assessTravel(attempts, { ...settings, bounds: { ...settings.bounds, max: 16 } }).status, 'no-improvement');
});

test('proposes a smaller release distance when the captured second press could not reset', () => {
  const miss = () => attempt(2, [0, 100, 140, 126, 142, 142, 0],
    [false, true, true, true, true, true, false]);
  assert.deepEqual(assessTravel([single(), miss(), single(), miss(), single()], { ...settings, field: 'release' }), {
    status: 'candidate', distance: 14, originalErrors: 2, candidateErrors: 0,
  });
});

test('does not fit slow samples, a mixed key, or a trace still held down', () => {
  const slow = [bounce(100), deliberate(100), bounce(100), deliberate(100), bounce(100)];
  assert.equal(assessTravel(slow, settings).status, 'insufficient');
  const bad = bounce();
  bad.samples[2].position = 70;
  assert.equal(assessTravel([bad, deliberate(), bounce(), deliberate(), bounce()], settings).status, 'insufficient');
  const held = bounce();
  held.samples.at(-1)!.rawTravel = 1230;
  assert.equal(assessTravel([held, deliberate(), bounce(), deliberate(), bounce()], settings).status, 'insufficient');
});

test('withholds a value when the reference replay disagrees or there are no errors to reduce', () => {
  const attempts = [bounce(), deliberate(), bounce(), deliberate(), bounce()];
  assert.equal(assessTravel(attempts, { ...settings, press: 20, release: 20 }).status, 'mismatch');
  assert.equal(assessTravel([single(), deliberate(), single(), deliberate(), single()], settings).status, 'no-improvement');
});
