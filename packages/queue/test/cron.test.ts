import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCron } from '../src/index.ts'

const at = (iso: string) => new Date(iso)
const next = (expr: string, from: string) => parseCron(expr).next(at(from)).toISOString()

describe('parseCron', () => {
  test('every minute and steps', () => {
    assert.equal(next('* * * * *', '2026-01-01T10:00:30Z'), '2026-01-01T10:01:00.000Z')
    assert.equal(next('*/15 * * * *', '2026-01-01T10:01:00Z'), '2026-01-01T10:15:00.000Z')
    assert.equal(next('*/15 * * * *', '2026-01-01T10:45:00Z'), '2026-01-01T11:00:00.000Z')
    assert.equal(next('5-20/5 * * * *', '2026-01-01T10:16:00Z'), '2026-01-01T10:20:00.000Z')
  })

  test('strictly after the given time', () => {
    assert.equal(next('0 3 * * *', '2026-01-01T03:00:00Z'), '2026-01-02T03:00:00.000Z')
  })

  test('lists, ranges and names', () => {
    assert.equal(next('0 9 * * mon-fri', '2026-01-02T10:00:00Z'), '2026-01-05T09:00:00.000Z') // Fri -> Mon
    assert.equal(next('30 8,20 * * *', '2026-01-01T09:00:00Z'), '2026-01-01T20:30:00.000Z')
    assert.equal(next('0 0 1 jan,jul *', '2026-02-01T00:00:00Z'), '2026-07-01T00:00:00.000Z')
    assert.equal(next('0 0 * * 7', '2026-01-01T00:00:00Z'), '2026-01-04T00:00:00.000Z') // 7 is Sunday
  })

  test('day of month OR day of week when both are set', () => {
    // The 13th, or any Friday: Fri Jan 2 comes first.
    assert.equal(next('0 0 13 * fri', '2026-01-01T00:00:00Z'), '2026-01-02T00:00:00.000Z')
  })

  test('macros and rare dates', () => {
    assert.equal(next('@hourly', '2026-01-01T10:59:00Z'), '2026-01-01T11:00:00.000Z')
    assert.equal(next('@monthly', '2026-01-31T12:00:00Z'), '2026-02-01T00:00:00.000Z')
    assert.equal(next('0 0 29 2 *', '2026-03-01T00:00:00Z'), '2028-02-29T00:00:00.000Z')
    assert.equal(next('0 0 31 * *', '2026-04-01T00:00:00Z'), '2026-05-31T00:00:00.000Z')
  })

  test('mistakes fail with a hint', () => {
    assert.throws(() => parseCron('* * * *'), /expected 5 fields.*e\.g\./)
    assert.throws(() => parseCron('60 * * * *'), /minute "60" is not in 0-59/)
    assert.throws(() => parseCron('*/0 * * * *'), /bad step/)
    assert.throws(() => parseCron('0 0 10-5 * *'), /runs backwards/)
    assert.throws(() => parseCron('0 0 30 feb *'), /never occurs/)
    assert.equal(next('0 0 30 2 mon', '2027-01-01T00:00:00Z'), '2027-02-01T00:00:00.000Z', 'day of month OR day of week')
    assert.throws(() => parseCron('? * * * *'), /only allowed in the day fields/)
  })
})
