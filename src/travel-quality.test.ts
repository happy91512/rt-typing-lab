import assert from 'node:assert/strict';
import test from 'node:test';
import type { TravelReading } from './travel-device.ts';
import { summarizeCadence, summarizeTravel } from './travel-quality.ts';
import type { DigitalEdge } from './travel-quality.ts';

function readings(times: readonly number[], transitions: readonly DigitalEdge[]): TravelReading[] {
  const newestFirst = [...transitions].reverse();
  return times.map(receivedAt => ({
    position: 37,
    rawTravel: 0,
    receivedAt,
    pressed: newestFirst.find(edge => edge.receivedAt <= receivedAt)?.pressed ?? false,
  }));
}

function spaced(count: number, step: number, start = 0): number[] {
  return Array.from({ length: count }, (_, index) => start + index * step);
}

function alternating(times: readonly number[]): DigitalEdge[] {
  return times.map((receivedAt, index) => ({ pressed: index % 2 === 0, receivedAt }));
}

test('reports actual cadence without requiring key events and skips duplicated or invalid timestamps', () => {
  assert.deepEqual(summarizeCadence(readings([0, 20, 20, -1, 40, 140, Number.NaN, 160], [])), {
    samples: 5, medianIntervalMs: 20, maxIntervalMs: 100,
  });
  assert.deepEqual(summarizeCadence(readings([0], [])), {
    samples: 1, medianIntervalMs: null, maxIntervalMs: null,
  });
});

test('reports aligned only after ten edges with dense, matching telemetry', () => {
  const edges = alternating(spaced(10, 40, 100));
  const telemetry = readings(spaced(60, 10), edges);
  assert.equal(summarizeTravel(telemetry, edges.slice(0, 9)).quality, 'collecting');
  assert.deepEqual(summarizeTravel(telemetry, edges), {
    samples: 60, medianIntervalMs: 10, maxIntervalMs: 10,
    matchedEdges: 10, edges: 10, quality: 'aligned',
  });
});

test('does not qualify a 100 ms report cadence even when all edges match', () => {
  const edges = alternating(spaced(10, 100, 100));
  const metrics = summarizeTravel(readings(spaced(12, 100), edges), edges);
  assert.equal(metrics.matchedEdges, 10);
  assert.equal(metrics.medianIntervalMs, 100);
  assert.equal(metrics.maxIntervalMs, 100);
  assert.equal(metrics.quality, 'insufficient');
});

test('includes the 90 percent match and 25 ms median boundaries', () => {
  const edges = alternating(spaced(10, 50, 100));
  const telemetry = readings(spaced(24, 25), edges);
  const oneMismatch = edges.map((edge, index) => index === 9 ? { ...edge, pressed: true } : edge);
  const boundary = summarizeTravel(telemetry, oneMismatch);
  assert.equal(boundary.matchedEdges, 9);
  assert.equal(boundary.medianIntervalMs, 25);
  assert.equal(boundary.quality, 'aligned');
  const twoMismatches = oneMismatch.map((edge, index) => index === 1 ? { ...edge, pressed: true } : edge);
  assert.equal(summarizeTravel(telemetry, twoMismatches).quality, 'insufficient');
});

test('rejects isolated long gaps and ignores gaps outside the digital event span', () => {
  const edges = alternating(spaced(10, 40, 100));
  const times = spaced(60, 10).filter(time => time >= 100);
  const outside = summarizeTravel(readings([0, ...times], edges), edges);
  assert.equal(outside.maxIntervalMs, 10);
  const gap = summarizeTravel(readings(spaced(60, 10).filter(time => time < 200 || time >= 260), edges), edges);
  assert.equal(gap.medianIntervalMs, 10);
  assert.equal(gap.maxIntervalMs, 70);
  assert.equal(gap.quality, 'insufficient');
});

test('treats an unobserved tail in the digital span as a gap', () => {
  const firstNine = alternating(spaced(9, 30, 50));
  const edges = [...firstNine, { receivedAt: 500, pressed: false }];
  const metrics = summarizeTravel(readings(spaced(32, 10), firstNine), edges);
  assert.equal(metrics.matchedEdges, 9);
  assert.equal(metrics.medianIntervalMs, 10);
  assert.equal(metrics.maxIntervalMs, 190);
  assert.equal(metrics.quality, 'insufficient');
});

test('matches overlapping press windows in order and never reuses a sampled transition', () => {
  const telemetry = readings([0, 10, 15, 30], alternating([10, 15, 30]));
  assert.equal(summarizeTravel(telemetry, [
    { pressed: true, receivedAt: 27 },
    { pressed: true, receivedAt: 31 },
  ]).matchedEdges, 2);
  assert.equal(summarizeTravel(telemetry, [
    { pressed: true, receivedAt: 27 },
    { pressed: true, receivedAt: 27 },
    { pressed: true, receivedAt: 31 },
  ]).matchedEdges, 2);
  assert.equal(summarizeTravel(telemetry, alternating([20, 21, 22, 23])).matchedEdges, 3);
  assert.equal(summarizeTravel(telemetry.slice(0, 3), [
    { pressed: false, receivedAt: 13 },
    { pressed: true, receivedAt: 14 },
  ]).matchedEdges, 1);
});

test('matches only the same polarity within 30 ms and filters invalid timestamps', () => {
  const samples = readings([0, 10, 10, 9, Infinity, 20], [{ pressed: true, receivedAt: 10 }]);
  const edges = [
    { pressed: false, receivedAt: -1 },
    { pressed: false, receivedAt: 5 },
    { pressed: true, receivedAt: 4 },
    { pressed: true, receivedAt: NaN },
    { pressed: true, receivedAt: 40 },
    { pressed: true, receivedAt: 41 },
  ];
  const metrics = summarizeTravel(samples, edges);
  assert.equal(metrics.samples, 3);
  assert.equal(metrics.edges, 3);
  assert.equal(metrics.matchedEdges, 1);
  assert.equal(summarizeTravel(samples, [{ pressed: true, receivedAt: 41 }]).matchedEdges, 0);
});
