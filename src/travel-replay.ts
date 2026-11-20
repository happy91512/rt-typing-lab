import type { TravelReading } from './travel-device.ts';
import { summarizeTravel } from './travel-quality.ts';
import type { DigitalEdge } from './travel-quality.ts';

// Distances in the study and these settings are hundredths of a millimeter.
export type ReplaySettings = {
  actuation: number;
  top: number;
  bottom: number;
  full: number;
  press: number;
  release: number;
  field: 'linked' | 'press' | 'release';
  bounds: { min: number; max: number; step: number };
};

export type TravelAttempt = {
  expected: 1 | 2;
  samples: TravelReading[];
  edges: DigitalEdge[];
};

type Assessment = { status: 'insufficient' | 'mismatch' | 'no-improvement' }
  | { status: 'candidate'; distance: number; originalErrors: number; candidateErrors: number };

function isGrid(value: number, { min, max, step }: ReplaySettings['bounds']): boolean {
  return Number.isInteger(value) && value >= min && value <= max && (value - min) % step === 0;
}

function valid(settings: ReplaySettings): boolean {
  const { actuation, top, bottom, full, press, release, field, bounds } = settings;
  return [actuation, top, bottom, full, press, release, bounds.min, bounds.max, bounds.step]
    .every(value => Number.isInteger(value) && value >= 0)
    && bounds.min > 0 && bounds.step > 0
    && isGrid(field === 'release' ? release : press, bounds)
    && press > 0 && release > 0 && top < actuation && actuation <= full - bottom
    && (field !== 'linked' || press === release);
}

function depth(raw: number, step: number): number {
  // The HERO driver scales raw counts by its firmware precision in micrometers.
  // Its RT slider uses the same precision for one step.
  return raw * step / 10;
}

function run(samples: readonly TravelReading[], settings: ReplaySettings) {
  let belowTop = false;
  let pressed = false;
  let extremum = 0;
  let presses = 0;
  const state = samples.map(sample => {
    const position = Math.min(depth(sample.rawTravel, settings.bounds.step), settings.full - settings.bottom);
    if (position <= settings.top) {
      pressed = false;
      belowTop = false;
      return pressed;
    }
    if (!belowTop) {
      if (position >= settings.actuation) {
        pressed = true;
        belowTop = true;
        extremum = position;
        presses++;
      }
      return pressed;
    }
    if (pressed) {
      extremum = Math.max(extremum, position);
      if (extremum - position >= settings.release) {
        pressed = false;
        extremum = position;
      }
    } else {
      extremum = Math.min(extremum, position);
      if (position - extremum >= settings.press) {
        pressed = true;
        extremum = position;
        presses++;
      }
    }
    return pressed;
  });
  return { presses, state };
}

export function assessTravel(attempts: readonly TravelAttempt[], settings: ReplaySettings): Assessment {
  if (!valid(settings) || attempts.length < 5 || !attempts.some(attempt => attempt.expected === 2)) return { status: 'insufficient' };
  const quality = attempts.map(attempt => summarizeTravel(attempt.samples, attempt.edges));
  if (quality.some(result => result.medianIntervalMs === null || result.medianIntervalMs > 25
    || result.maxIntervalMs === null || result.maxIntervalMs > 60 || result.edges === 0)
    || quality.reduce((total, result) => total + result.edges, 0) < 10
    || quality.reduce((total, result) => total + (result.edges - result.matchedEdges), 0) !== 0) return { status: 'insufficient' };

  const step = settings.bounds.step;
  const originalErrorsByAttempt: number[] = [];
  for (const attempt of attempts) {
    const first = attempt.samples[0];
    const last = attempt.samples.at(-1);
    if (!first || !last || first.position !== last.position || first.pressed || last.pressed
      || depth(first.rawTravel, step) > settings.top || depth(last.rawTravel, step) > settings.top
      || attempt.samples.some((sample, index) => sample.position !== first.position || !Number.isFinite(sample.rawTravel)
        || !Number.isFinite(sample.receivedAt) || sample.receivedAt < 0
        || sample.rawTravel < 0 || depth(sample.rawTravel, step) > settings.full + step
        || (index > 0 && sample.receivedAt <= attempt.samples[index - 1].receivedAt))) return { status: 'insufficient' };
    const original = run(attempt.samples, settings);
    if (original.presses !== attempt.edges.filter(edge => edge.pressed).length
      || original.state.some((pressed, index) => pressed !== attempt.samples[index].pressed)) return { status: 'mismatch' };
    originalErrorsByAttempt.push(Math.abs(original.presses - attempt.expected));
  }

  const originalErrors = originalErrorsByAttempt.reduce((sum, errors) => sum + errors, 0);
  if (originalErrors === 0) return { status: 'no-improvement' };
  const center = settings.field === 'release' ? settings.release : settings.press;
  let best: Assessment = { status: 'no-improvement' };
  for (let offset = step; offset <= Math.max(step, 5); offset += step) {
    for (const distance of [center + offset, center - offset]) {
      if (!isGrid(distance, settings.bounds)) continue;
      const candidate = {
        ...settings,
        press: settings.field === 'release' ? settings.press : distance,
        release: settings.field === 'press' ? settings.release : distance,
      };
      const errors = attempts.map(attempt => Math.abs(run(attempt.samples, candidate).presses - attempt.expected));
      if (errors.some((value, index) => value > originalErrorsByAttempt[index])) continue;
      const candidateErrors = errors.reduce((sum, value) => sum + value, 0);
      if (candidateErrors < originalErrors && (best.status !== 'candidate' || candidateErrors < best.candidateErrors)) {
        best = { status: 'candidate', distance, originalErrors, candidateErrors };
      }
    }
  }
  return best;
}
