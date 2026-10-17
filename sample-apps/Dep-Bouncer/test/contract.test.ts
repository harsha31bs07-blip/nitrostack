import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEVERITY_WEIGHT } from '../src/modules/analysis/signal.js';

test('severity weights increase with severity', () => {
  assert.ok(SEVERITY_WEIGHT.info < SEVERITY_WEIGHT.warn);
  assert.ok(SEVERITY_WEIGHT.warn < SEVERITY_WEIGHT.high);
  assert.ok(SEVERITY_WEIGHT.high < SEVERITY_WEIGHT.critical);
  assert.equal(SEVERITY_WEIGHT.critical, 70);
});
