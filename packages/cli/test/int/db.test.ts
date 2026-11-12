import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/bolide'
const bin = fileURLToPath(new URL('../../bin/bolide.mjs', import.meta.url))
const dir = fileURLToPath(new URL(`../.tmp-db-${process.pid}/`, import.meta.url))
const schema = `bolide_cli_${process.pid}`
const sql = postgres(url, { onnotice: () => {} })

describe('bolide db migrate', () => {
  after(async () => {
    await sql.unsafe(`drop schema if exists ${schema} cascade`)
    await sql.unsafe(`delete from bolide_migrations where name like $1`, [`%_cli_${process.pid}`]).catch(() => {})
    await sql.end()
    await rm(dir, { recursive: true, force: true })
  })

  test('applies pending files once and reports what it did', async () => {
    await mkdir(join(dir, 'migrations'), { recursive: true })
    await writeFile(join(dir, 'migrations', `0001_cli_${process.pid}.sql`), `create schema ${schema}; create table ${schema}.notes (id int primary key);`)
    const migrate = () => execFileSync(process.execPath, [bin, 'db', 'migrate'], { cwd: dir, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } })
    assert.match(migrate(), new RegExp(`applied 0001_cli_${process.pid}\\n1 migration\\(s\\) applied`))
    assert.match(migrate(), /up to date/)
    assert.equal((await sql.unsafe(`select count(*)::int as n from ${schema}.notes`))[0]!.n, 0)
  })
})
