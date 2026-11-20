import type { TravelReading } from './travel-device.ts';

export type DigitalEdge = { pressed: boolean; receivedAt: number };

const minimumEdges = 10;
const matchWindowMs = 30;

function chronological<T extends DigitalEdge>(entries: readonly T[], keepTies: boolean): T[] {
  const valid: T[] = [];
  let previous = -Infinity;
  for (const entry of entries) {
    const time = entry.receivedAt;
    if (!Number.isFinite(time) || time < 0 || time < previous || (!keepTies && time === previous)) continue;
    valid.push(entry);
    previous = time;
  }
  return valid;
}

function countMatches(transitions: readonly DigitalEdge[], edges: readonly DigitalEdge[]): number {
  // Skipping either observation is allowed, but every match consumes one of each in order.
  let previous = new Uint32Array(transitions.length + 1);
  let current = new Uint32Array(transitions.length + 1);
  for (const edge of edges) {
    for (const [index, transition] of transitions.entries()) {
      const matches = transition.pressed === edge.pressed
        && Math.abs(transition.receivedAt - edge.receivedAt) <= matchWindowMs;
      current[index + 1] = matches
        ? Math.max(previous[index + 1], current[index], previous[index] + 1)
        : Math.max(previous[index + 1], current[index]);
    }
    [previous, current] = [current, previous];
  }
  return previous[transitions.length];
}

export function summarizeTravel(samples: readonly TravelReading[], edges: readonly DigitalEdge[]): {
  samples: number;
  medianIntervalMs: number | null;
  maxIntervalMs: number | null;
  matchedEdges: number;
  edges: number;
  quality: 'collecting' | 'insufficient' | 'aligned';
} {
  const readings = chronological(samples, false);
  const events = chronological(edges, true);
  const start = events[0]?.receivedAt ?? Infinity;
  const end = events.at(-1)?.receivedAt ?? -Infinity;
  const intervals: number[] = [];
  const transitions: TravelReading[] = [];
  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1];
    const reading = readings[index];
    if (start < end && previous.receivedAt < end && reading.receivedAt > start) {
      intervals.push(reading.receivedAt - previous.receivedAt);
    }
    if (reading.pressed !== previous.pressed
      && reading.receivedAt >= start - matchWindowMs
      && reading.receivedAt <= end + matchWindowMs) {
      transitions.push(reading);
    }
  }
  intervals.sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  const medianIntervalMs = intervals.length === 0
    ? null
    : (intervals[Math.floor((intervals.length - 1) / 2)] + intervals[middle]) / 2;
  const maxIntervalMs = start < end && readings.length > 0
    ? Math.max(
      intervals.at(-1) ?? 0,
      Math.min(end, readings[0].receivedAt) - start,
      end - Math.max(start, readings[readings.length - 1].receivedAt),
    )
    : null;
  const matchedEdges = countMatches(transitions, events);
  const aligned = matchedEdges * 10 >= events.length * 9
    && medianIntervalMs !== null && medianIntervalMs <= 25
    && maxIntervalMs !== null && maxIntervalMs <= 60;
  return {
    samples: readings.length,
    medianIntervalMs,
    maxIntervalMs,
    matchedEdges,
    edges: events.length,
    quality: events.length < minimumEdges ? 'collecting' : aligned ? 'aligned' : 'insufficient',
  };
}
