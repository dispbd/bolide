import 'fake-indexeddb/auto'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { indexedDbStorage } from '../src/idb.ts'

describe('indexedDbStorage', () => {
  test('keeps values across instances and lists a prefix in key order', async () => {
    const a = indexedDbStorage('test-db')
    await a.set('mutation:u:2:b', { n: 2 })
    await a.set('mutation:u:1:a', { n: 1 })
    await a.set('mutation:v:1:c', { n: 3 })
    await a.set('shape:u:todos', { rows: [] })

    const b = indexedDbStorage('test-db')
    assert.deepEqual(await b.get('shape:u:todos'), { rows: [] })
    assert.deepEqual(await b.list('mutation:u:'), [
      ['mutation:u:1:a', { n: 1 }],
      ['mutation:u:2:b', { n: 2 }],
    ])
    await b.delete('mutation:u:1:a')
    assert.deepEqual((await a.list('mutation:')).map(([k]) => k), ['mutation:u:2:b', 'mutation:v:1:c'])
    assert.equal(await a.get('missing'), undefined)
  })
})
