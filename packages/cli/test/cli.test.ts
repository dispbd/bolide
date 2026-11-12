import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create, run } from '../src/index.ts'
import { packageFields } from '../src/template.ts'

// Inside the repo, so generated projects resolve @bolide/core, zod and tsx from the workspace.
const tmp = fileURLToPath(new URL('./.tmp/', import.meta.url))
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const bin = fileURLToPath(new URL('../bin/bolide.mjs', import.meta.url))
const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url))
const tsxCli = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url))

before(() => rm(tmp, { recursive: true, force: true }))
after(() => rm(tmp, { recursive: true, force: true }))

function capture() {
  const lines: string[] = []
  return { lines, log: (l: string) => void lines.push(l), text: () => lines.join('\n') }
}

describe('bolide create', () => {
  test('writes a project that typechecks and passes its own test', async () => {
    const dir = join(tmp, 'My App')
    const out = capture()
    assert.equal(await run(['create', dir, '--local', repo], out.log), 0)
    assert.match(out.text(), /Created my-app/)

    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'my-app')
    assert.equal(pkg.dependencies['@bolide/core'], 'file:../../../../core')
    assert.equal(pkg.devDependencies['@bolide/cli'], 'file:../../..')
    assert.equal(pkg.scripts.dev, 'bolide dev')

    execFileSync(process.execPath, [tsc, '-p', dir], { stdio: 'pipe' })
    execFileSync(process.execPath, [tsxCli, '--test', join(dir, 'test/users.test.ts')], { stdio: 'pipe', cwd: dir })
  })

  test('refuses a non-empty directory unless --force, which never overwrites', async () => {
    const dir = join(tmp, 'busy')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'keep.txt'), 'x')
    const err = capture()
    assert.equal(await run(['create', dir], undefined, err.log), 1)
    assert.match(err.text(), /is not empty.*--force/)
    assert.equal(await run(['create', dir, '--force'], () => {}), 0)
    assert.equal(await readFile(join(dir, 'keep.txt'), 'utf8'), 'x')
    await writeFile(join(dir, 'package.json'), '{"name":"mine"}')
    const out = capture()
    assert.equal(await run(['create', dir, '--force'], out.log), 0)
    assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), '{"name":"mine"}')
    assert.match(out.text(), /Kept existing files: .*package\.json/)
    // The hint is the same set of fields a generated package.json gets.
    const hint = JSON.parse(out.text().split('Merge these fields into it:\n')[1]!.split('\nCreated')[0]!)
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.deepEqual(hint, packageFields({ core: `^${version}`, cli: `^${version}` }))
  })

  test('pins published versions to the CLI version by default', async () => {
    const { dir } = await create({ dir: join(tmp, 'published') })
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(pkg.dependencies['@bolide/core'], `^${version}`)
    assert.equal(pkg.devDependencies['@bolide/cli'], `^${version}`)
  })

  test('--template todos writes the todos example, linked to the checkout, and it typechecks and passes its tests', async () => {
    const dir = join(tmp, 'todos')
    const out = capture()
    assert.equal(await run(['create', dir, '--template', 'todos', '--local', repo], out.log), 0)
    assert.match(out.text(), /npm run dev/)
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'todos')
    assert.equal(pkg.dependencies['@bolide/react'], 'file:../../../../react')
    assert.equal(pkg.devDependencies['@bolide/cli'], 'file:../../..')
    assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'node_modules/\ndist/\n.env\n')
    assert.match(await readFile(join(dir, 'migrations/0001_init.sql'), 'utf8'), /create table "todos"/)

    execFileSync(process.execPath, [tsc, '-p', dir], { stdio: 'pipe' })
    execFileSync(process.execPath, [tsxCli, '--test', 'test/todos.test.ts'], { stdio: 'pipe', cwd: dir })
  })

  test('an unknown template is refused with the list', async () => {
    const err = capture()
    assert.equal(await run(['create', join(tmp, 'x'), '--template', 'blog'], undefined, err.log), 1)
    assert.match(err.text(), /unknown template "blog". Pick one of: default, todos/)
  })
})

describe('the todos example', () => {
  test('its first migration creates the tables its schema defines', async () => {
    const { schemaSql } = await import('@bolide/data/server')
    const { todos } = await import('../../../examples/todos/src/shared/schema.ts')
    const migration = await readFile(new URL('../../../examples/todos/migrations/0001_init.sql', import.meta.url), 'utf8')
    assert.ok(migration.includes(schemaSql([todos])), 'run `npm run db:sql` in examples/todos and update the migration')
  })
})

describe('arguments', () => {
  test('usage mistakes exit 2 with help', async () => {
    for (const argv of [['create'], ['nope'], ['create', 'a', '--bogus'], ['dev', '--port', 'abc']]) {
      const err = capture()
      assert.equal(await run(argv, () => {}, err.log), 2, argv.join(' '))
      assert.match(err.text(), /Usage: bolide/)
    }
  })

  test('a file as target or a wrong --local path explains the mistake', async () => {
    await mkdir(tmp, { recursive: true })
    const file = join(tmp, 'a-file.txt')
    await writeFile(file, 'x')
    let err = capture()
    assert.equal(await run(['create', file], () => {}, err.log), 1)
    assert.match(err.text(), /is a file/)
    err = capture()
    assert.equal(await run(['create', join(tmp, 'x'), '--local', join(tmp, 'nope')], () => {}, err.log), 1)
    assert.match(err.text(), /not a Bolide checkout/)
  })

  test('help exits 0', async () => {
    const out = capture()
    assert.equal(await run(['help'], out.log), 0)
    assert.match(out.text(), /create <dir>/)
  })

  test('dev with a missing entry explains how to fix it', async () => {
    const err = capture()
    assert.equal(await run(['dev', join(tmp, 'missing.ts')], () => {}, err.log), 1)
    assert.match(err.text(), /does not exist.*bolide dev src\/server.ts/)
  })
})

describe('bolide dev', () => {
  test('serves the app and restarts on change', async () => {
    const dir = join(tmp, 'devapp')
    await create({ dir, local: repo })
    const port = await freePort()
    const child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], { cwd: dir, stdio: 'pipe', env: { ...process.env, LOG_LEVEL: 'info' } })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    try {
      await until(() => output.includes('listening on http://'), () => output)
      assert.equal((await fetch(`http://localhost:${port}/users`)).status, 200)

      const module = join(dir, 'src/users/users.module.ts')
      await writeFile(module, (await readFile(module, 'utf8')).replace("path: '/',\n  summary: 'List users'", "path: '/all',\n  summary: 'List users'"))
      await until(async () => (await fetch(`http://localhost:${port}/users/all`).catch(() => undefined))?.status === 200, () => output)
    } finally {
      child.kill('SIGTERM')
      await new Promise((done) => child.once('exit', done))
    }
  })
})

async function until(check: () => boolean | Promise<boolean>, describe: () => string, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out; output:\n${describe()}`)
}

function freePort() {
  return new Promise<number>((done) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => done(port))
    })
  })
}

describe('bolide db', () => {
  test('db sql prints the tables a schema module exports', async () => {
    const dir = join(tmp, 'db-sql')
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(
      join(dir, 'src/schema.ts'),
      `import { defineTable, t } from '@bolide/data'
export const users = defineTable('users', { id: t.uuid().primaryKey() })
export const posts = defineTable('posts', { id: t.uuid().primaryKey(), authorId: t.uuid().references(() => users) })
export const notATable = { name: 'x' }
`,
    )
    const out = execFileSync(process.execPath, [bin, 'db', 'sql'], { cwd: dir, encoding: 'utf8' })
    assert.match(out, /create table "users"[\s\S]*create table "posts"[\s\S]*"author_id" uuid not null references "users" \("id"\)/)
    const err = capture()
    assert.equal(await run(['db', 'sql', 'src/nope.ts'], undefined, err.log), 1)
    assert.match(err.text(), /nope.ts does not exist/)
    assert.equal(await run(['db', 'migrate', '--dir', join(dir, 'nowhere')], undefined, err.log), 1)
    assert.match(err.text(), /DATABASE_URL|nowhere does not exist/)
    assert.equal(await run(['db', 'drop'], undefined, err.log), 2)
  })
})
