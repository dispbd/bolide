import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BolideError, toMs } from '../src/index.ts'

test('toMs reads numbers and unit strings, and rejects the rest', () => {
  assert.equal(toMs(250), 250)
  assert.equal(toMs('250ms'), 250)
  assert.equal(toMs('1.5s'), 1500)
  assert.equal(toMs('5m'), 300_000)
  assert.equal(toMs('2h'), 7_200_000)
  assert.equal(toMs('7d'), 604_800_000)
  for (const bad of [-1, NaN, Infinity, '5', '5 m', '-5s', '5w']) {
    assert.throws(() => toMs(bad as never, 'ttl'), (e: Error) => e instanceof BolideError && /^ttl must be/.test(e.message))
  }
})
