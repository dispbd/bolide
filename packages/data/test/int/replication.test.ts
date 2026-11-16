import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { defineShape, defineTable, t } from '../../src/index.ts'
import { replicationSync, schemaSql, type SyncSource } from '../../src/server/index.ts'
import { follower } from './follow.ts'

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/bolide'
const schema = `bolide_repl_${process.pid}`
const slot = `bolide_test_${process.pid}`
const publication = `bolide_test_${process.pid}`
const admin = postgres(url, { onnotice: () => {} })
const sql = postgres(url, { onnotice: () => {}, connection: { search_path: schema } })

const items = defineTable('items', {
  id: t.integer().primaryKey(),
  ownerId: t.text(),
  title: t.text(),
  done: t.boolean().default(false),
  meta: t.json<{ tag: string }>().nullable(),
  at: t.timestamp().nullable(),
})
const all = defineShape('items.all', items)
const owned = (owner: string) => defineShape('items.owned', items, { where: () => ({ ownerId: owner }) })

const open = (options: Partial<Parameters<typeof replicationSync>[1]> = {}) => replicationSync(sql, { url, slot, publication, longPoll: 300, ...options })

const dbTitles = async (where = 'true') => ((await sql.unsafe(`select title from items where ${where} order by title`)) as { title: string }[]).map((r) => r.title)
/** Polls until the follower shows what the table (filtered by `where`) has now. */
async function settle(f: ReturnType<typeof follower>, where = 'true') {
  const expected = await dbTitles(where)
  for (let i = 0; i < 100; i++) {
    await f.catchUp()
    if (JSON.stringify(f.titles()) === JSON.stringify(expected)) return
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.deepEqual(f.titles(), expected)
}

describe('replicationSync on Postgres', () => {
  let sync: SyncSource
  before(async () => {
    await admin.unsafe(`create schema ${schema}`)
    await sql.unsafe(schemaSql([items]))
    sync = open()
    await sync.start!(['items'])
  })
  after(async () => {
    await sync?.close?.()
    await sql.end()
    await admin.unsafe(`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = '${slot}'`).catch(() => {})
    await admin.unsafe(`drop publication if exists ${publication}`)
    await admin.unsafe(`drop schema if exists ${schema} cascade`)
    await admin.end()
  })

  test('changes arrive with their txid, typed like the first load, and leave a shape when they stop matching', async () => {
    await sql.unsafe(`insert into items (id, owner_id, title, meta, at) values (1, 'ann', 'a', '{"tag":"x"}', '2026-01-01T10:00:00Z')`)
    const ann = follower(() => sync, owned('ann'))
    assert.equal(await ann.catchUp(), 'up-to-date')
    const loaded = [...ann.rows.values()][0]!
    assert.equal(loaded.title, 'a')
    assert.deepEqual(loaded.meta, { tag: 'x' })

    const [{ txid }] = (await sql.begin(async (tx) => {
      await tx.unsafe(`insert into items (id, owner_id, title, meta, at) values (2, 'ann', 'b', '{"tag":"y"}', '2026-02-01T10:00:00Z')`)
      return tx.unsafe(`select pg_current_xact_id()::xid::text as txid`)
    })) as [{ txid: string }]
    await settle(ann, `owner_id = 'ann'`)
    const second = [...ann.rows.values()].find((r) => r.id === 2)!
    assert.deepEqual(Object.keys(second).sort(), Object.keys(loaded).sort(), 'same columns as the first load')
    assert.deepEqual(second.meta, { tag: 'y' }, 'json is json, not a string')
    assert.equal(second.done, false)
    assert.equal(typeof second.at, typeof loaded.at)
    assert.ok(ann.txids.includes(Number(txid)), 'the txid that confirms the mutation')

    await sql.unsafe(`update items set title = 'a2' where id = 1`)
    await sql.unsafe(`update items set owner_id = 'bob' where id = 2`)
    await settle(ann, `owner_id = 'ann'`)
    assert.deepEqual(ann.titles(), ['a2'], 'given away: deleted from ann\'s shape')

    const bob = follower(() => sync, owned('bob'))
    await bob.catchUp()
    await sql.unsafe(`update items set owner_id = 'bob' where id = 1`)
    await sql.unsafe(`delete from items where id = 2`)
    await settle(bob, `owner_id = 'bob'`)
    await settle(ann, `owner_id = 'ann'`)
    assert.deepEqual(bob.titles(), ['a2'])
    assert.deepEqual(ann.titles(), [])
    await sql.unsafe(`delete from items`)
  })

  test('concurrent writers and first loads end up equal to the table', async () => {
    let stop = false
    const writer = async (w: number) => {
      for (let n = 0; !stop; n++) {
        const id = 1000 + w * 10_000 + (n % 40)
        await sql.begin(async (tx) => {
          await tx.unsafe(`insert into items (id, owner_id, title) values ($1, 'ann', $2) on conflict (id) do update set title = excluded.title, done = not items.done`, [id, `w${w}-${n}`])
          if (n % 7 === 3) await tx.unsafe(`delete from items where id = $1`, [1000 + w * 10_000 + ((n * 13) % 40)])
        })
      }
    }
    const writers = [0, 1, 2, 3, 4, 5].map(writer)
    const followers: ReturnType<typeof follower>[] = []
    for (let i = 0; i < 12; i++) {
      const f = follower(() => sync, all)
      await f.catchUp()
      followers.push(f)
      await new Promise((r) => setTimeout(r, 40))
      await Promise.all(followers.map((x) => x.poll()))
    }
    stop = true
    await Promise.all(writers)
    const expected = await dbTitles()
    assert.ok(expected.length > 20)
    for (const f of followers) await settle(f)
    for (const [i, f] of followers.entries()) assert.deepEqual(f.titles(), expected, `follower ${i}`)
    await sql.unsafe(`delete from items`)
  })

  test('a live request waits for the next change', async () => {
    const f = follower(() => sync, all)
    await f.catchUp()
    const t0 = Date.now()
    // postgres.js runs a query only once it is awaited.
    setTimeout(() => void sql.unsafe(`insert into items (id, owner_id, title) values (5, 'ann', 'live')`).then(), 50)
    while (!f.titles().length && Date.now() - t0 < 1000) assert.equal(await f.poll(true), 'up-to-date')
    assert.ok(Date.now() - t0 < 290, 'answered by the change, not the long-poll timeout')
    assert.deepEqual(f.titles(), ['live'])
    await sql.unsafe(`delete from items`)
  })

  test('a restart resumes from the slot: offsets stay valid and nothing is lost', async () => {
    const f = follower(() => sync, all)
    await f.catchUp()
    await sql.unsafe(`insert into items (id, owner_id, title) values (10, 'ann', 'before')`)
    await settle(f)
    await sync.close!()
    await sql.unsafe(`insert into items (id, owner_id, title) values (11, 'ann', 'while down')`)
    sync = open()
    await sync.start!(['items'])
    // The same follower, with the offset it had: same handle, so it just continues.
    assert.notEqual(await f.poll(), 'must-refetch')
    await settle(f)
    assert.deepEqual(f.titles(), ['before', 'while down'])
    await sql.unsafe(`delete from items`)
    await settle(f)
    assert.deepEqual(f.titles(), [])
  })

  test('a lost slot and a truncate make clients load again', async () => {
    const f = follower(() => sync, all)
    await f.catchUp()
    await sync.close!()
    await admin.unsafe(`select pg_drop_replication_slot('${slot}')`)
    await sql.unsafe(`insert into items (id, owner_id, title) values (20, 'ann', 'unseen')`)
    sync = open()
    await sync.start!(['items'])
    assert.equal(await f.poll(), 'must-refetch')

    const g = follower(() => sync, all)
    await g.catchUp()
    assert.deepEqual(g.titles(), ['unseen'])
    await sql.unsafe(`truncate items`)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(await g.poll(), 'must-refetch')
  })

  test('setup mistakes fail at start with what to do', async () => {
    const other = replicationSync(sql, { url, slot: `${slot}_x`, publication })
    await assert.rejects(other.start!(['nope']), /no table "nope"/)
    await other.close!()
    const held = open()
    await assert.rejects(Promise.race([held.start!(['items']), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 10_000))]), /used by another process/)
    await held.close!()
    assert.throws(() => replicationSync(sql, { url, slot: 'Bad-Name' }), /lowercase/)
  })
})
