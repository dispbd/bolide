import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { defineTable, t } from '@bolide/data'
import { matches } from '../src/where.ts'

const items = defineTable('items', { id: t.uuid().primaryKey(), code: t.text(), price: t.numeric(), at: t.timestamp(), ownerId: t.uuid() })

describe('matches', () => {
  test('compares by the column type, like the SQL would', () => {
    assert.equal(matches(items, { code: '10' }, { code: { gt: '9' } }), false, 'text compares as text')
    assert.equal(matches(items, { price: '10.50' }, { price: { gt: '9' } }), true, 'decimals compare as numbers')
    assert.equal(matches(items, { at: '2026-11-12T10:00:00+01:00' }, { at: { lt: '2026-11-12T09:30:00Z' } }), true, 'timestamps compare as instants')
  })

  test('an undefined condition matches nothing', () => {
    assert.equal(matches(items, { ownerId: 'a' }, { ownerId: undefined }), false)
  })
})
