import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { defineShape, defineTable, query, t } from '../../src/index.ts'
import { postgresSync, replicationSync, schemaSql, type SyncSource } from '../../src/server/index.ts'
import { follower, type Follower } from './follow.ts'

// A rule that reads another table: "todos of the lists I'm a member of", on both Postgres sources.
const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/bolide'
const admin = postgres(url, { onnotice: () => {} })
after(() => admin.end())

const members = defineTable('members', { id: t.integer().primaryKey(), listId: t.integer(), userId: t.text() })
const todos = defineTable('todos', { id: t.integer().primaryKey(), listId: t.integer(), title: t.text() })
const shared = defineShape('todos.shared', todos, { where: ({ userId }) => (userId ? { listId: { in: query(members, 'listId', { userId }) } } : false) })

for (const source of ['postgresSync', 'replicationSync'] as const)
  describe(`rules across tables (${source})`, () => {
    const schema = `bolide_rules_${source.toLowerCase()}_${process.pid}`
    const slot = `bolide_rules_${process.pid}`
    const sql = postgres(url, { onnotice: () => {}, connection: { search_path: schema } })
    let sync: SyncSource
    before(async () => {
      await admin.unsafe(`create schema ${schema}`)
      await sql.unsafe(schemaSql([members, todos]))
      sync = source === 'postgresSync' ? postgresSync(sql, { longPoll: 300 }) : replicationSync(sql, { url, slot, publication: slot, longPoll: 300 })
      await sync.start?.(['todos', 'members'])
    })
    after(async () => {
      await sync?.close?.()
      await sql.end()
      await admin.unsafe(`drop schema if exists ${schema} cascade`)
      if (source === 'replicationSync') {
        await admin.unsafe(`select pg_drop_replication_slot($1) from pg_replication_slots where slot_name = $1`, [slot])
        await admin.unsafe(`drop publication if exists ${slot}`)
      }
    })

    /** Follows until up to date, loading again on must-refetch like the browser does; says whether it had to. */
    async function sync_(f: Follower) {
      let reloaded = false
      for (let i = 0; i < 20; i++) {
        const r = await f.poll()
        if (r === 'must-refetch') {
          reloaded = true
          await f.reload()
        } else if (r === 'up-to-date') return reloaded
      }
      throw new Error('never caught up')
    }
    /** Lets the change log (or the WAL) catch up with what was just committed. */
    const later = () => new Promise((r) => setTimeout(r, 150))

    test('joining and leaving a list shows and hides its todos; other changes cost nothing', async () => {
      await sql.unsafe(`insert into members values (1, 1, 'ann'), (2, 2, 'bob')`)
      await sql.unsafe(`insert into todos values (1, 1, 'ann list'), (2, 2, 'bob list')`)
      const ann = follower(() => sync, shared, 'ann')
      await ann.catchUp()
      assert.deepEqual(ann.titles(), ['ann list'])

      await sql.unsafe(`insert into todos values (3, 1, 'ann list 2'), (4, 2, 'bob list 2')`)
      await sql.unsafe(`insert into members values (3, 3, 'bob')`) // bob's membership: not ann's business
      await later()
      assert.equal(await sync_(ann), false, 'no reload for changes that leave the rule as it was')
      assert.deepEqual(ann.titles(), ['ann list', 'ann list 2'])

      await sql.unsafe(`insert into members values (4, 2, 'ann')`)
      await later()
      assert.equal(await sync_(ann), true, 'joined: load again')
      assert.deepEqual(ann.titles(), ['ann list', 'ann list 2', 'bob list', 'bob list 2'])

      await sql.unsafe(`delete from members where id = 1`)
      await later()
      assert.equal(await sync_(ann), true, 'left: load again')
      assert.deepEqual(ann.titles(), ['bob list', 'bob list 2'])

      await sql.unsafe(`update members set user_id = 'cat' where id = 4`)
      await later()
      assert.equal(await sync_(ann), true, 'membership given away')
      assert.deepEqual(ann.titles(), [])
    })

    test('a live request wakes up when the rule\'s table changes', async () => {
      const bob = follower(() => sync, shared, 'bob')
      await bob.catchUp()
      const t0 = Date.now()
      setTimeout(() => void sql.unsafe(`insert into members values (10, 1, 'bob')`).then(), 50)
      assert.equal(await bob.poll(true), 'must-refetch')
      assert.ok(Date.now() - t0 < 600, 'woken by the change, not the timeout')
    })
  })
