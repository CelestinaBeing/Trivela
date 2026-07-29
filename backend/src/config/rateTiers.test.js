import assert from 'node:assert/strict';
import test from 'node:test';
import { RATE_TIERS, VALID_RATE_TIERS, DEFAULT_RATE_TIER, getRateTierLimits } from './rateTiers.js';

test('VALID_RATE_TIERS stays in sync with the RATE_TIERS config keys', () => {
  assert.deepEqual([...VALID_RATE_TIERS].sort(), Object.keys(RATE_TIERS).sort());
});

test('DEFAULT_RATE_TIER is a valid tier', () => {
  assert.ok(VALID_RATE_TIERS.includes(/** @type {any} */ (DEFAULT_RATE_TIER)));
});

test('getRateTierLimits returns the matching tier config', () => {
  assert.deepEqual(getRateTierLimits('pro'), RATE_TIERS.pro);
  assert.deepEqual(getRateTierLimits('enterprise'), RATE_TIERS.enterprise);
});

test('getRateTierLimits falls back to the default tier for unknown/missing values', () => {
  assert.deepEqual(getRateTierLimits(undefined), RATE_TIERS[DEFAULT_RATE_TIER]);
  assert.deepEqual(getRateTierLimits(null), RATE_TIERS[DEFAULT_RATE_TIER]);
  assert.deepEqual(getRateTierLimits('not-a-real-tier'), RATE_TIERS[DEFAULT_RATE_TIER]);
});
