import assert from 'node:assert/strict';
import test from 'node:test';
import { typeableCodes } from './prompts.ts';
import { hero84TravelPositions } from './travel-positions.ts';

test('maps every printable HERO84 HE key to a distinct physical position', () => {
  assert.deepEqual(new Set(hero84TravelPositions.keys()), new Set(typeableCodes));
  assert.equal(new Set(hero84TravelPositions.values()).size, typeableCodes.length);
  assert.equal(hero84TravelPositions.get('KeyQ'), 29);
  assert.equal(hero84TravelPositions.get('Space'), 70);
});
