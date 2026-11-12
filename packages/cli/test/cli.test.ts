import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create, run } from '../src/index.ts'

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

  test('refuses a non-empty directory unless --force', async () => {
    const dir = join(tmp, 'busy')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'keep.txt'), 'x')
    const err = capture()
    assert.equal(await run(['create', dir], undefined, err.log), 1)
    assert.match(err.text(), /is not empty.*--force/)
    assert.equal(await run(['create', dir, '--force'], () => {}), 0)
    assert.equal(await readFile(join(dir, 'keep.txt'), 'utf8'), 'x')
  })

  test('links published versions by default', async () => {
    const { dir } = await create({ dir: join(tmp, 'published') })
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies['@bolide/core'], 'latest')
    assert.equal(pkg.devDependencies['@bolide/cli'], 'latest')
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
    const child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], { cwd: dir, stdio: 'pipe' })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    try {
      await until(() => output.includes('Listening on'), () => output)
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
