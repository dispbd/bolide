import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError } from './errors.ts'

export interface DbOptions {
  /** The module that exports the tables. Defaults to `bolide.schema` in package.json, then `src/schema.ts`. */
  schema?: string
  /** Folder of `0001_name.sql` files. Default `migrations`. */
  dir?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

// Runs in the project: its own @bolide/data, postgres and schema module, with tsx for TypeScript.
const scripts = {
  sql: `
const { schemaSql } = await import('@bolide/data/server')
const mod = await import(process.env.BOLIDE_SCHEMA)
const tables = Object.values(mod).filter((v) => v && typeof v === 'object' && v['~standard']?.vendor === 'bolide' && 'primaryKey' in v && 'columns' in v)
if (!tables.length) { console.error('bolide: ' + process.env.BOLIDE_SCHEMA_PATH + ' exports no tables (defineTable).'); process.exit(1) }
process.stdout.write(schemaSql(tables))
`,
  migrate: `
const { migrate, readMigrations } = await import('@bolide/data/server')
const postgres = (await import('postgres')).default
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 })
try {
  const result = await migrate(sql, await readMigrations(process.env.BOLIDE_MIGRATIONS))
  for (const name of result.applied) console.log('applied ' + name)
  console.log(result.applied.length ? result.applied.length + ' migration(s) applied, ' + result.skipped.length + ' already there' : 'up to date (' + result.skipped.length + ' migration(s))')
} catch (e) {
  console.error('bolide: ' + (e?.message ?? e))
  process.exitCode = 1
} finally {
  await sql.end()
}
`,
}

/**
 * `bolide db sql` prints CREATE TABLE statements for the tables a schema module exports, to start a migration.
 * `bolide db migrate` applies the pending migrations in `migrations/` to `DATABASE_URL`.
 */
export function db(command: 'sql' | 'migrate', options: DbOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd()
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) }
  if (command === 'sql') {
    const schema = resolve(cwd, options.schema ?? configured(cwd) ?? 'src/schema.ts')
    if (!existsSync(schema)) throw new CliError(`schema module ${schema} does not exist. Pass one (\`bolide db sql src/db/schema.ts\`) or set "bolide": { "schema": ... } in package.json.`)
    env.BOLIDE_SCHEMA = pathToFileURL(schema).href
    env.BOLIDE_SCHEMA_PATH = schema
  } else {
    if (!env.DATABASE_URL) throw new CliError('set DATABASE_URL to the database to migrate, e.g. DATABASE_URL=postgres://localhost/app bolide db migrate.')
    const dir = resolve(cwd, options.dir ?? 'migrations')
    if (!existsSync(dir)) throw new CliError(`migrations folder ${dir} does not exist. Create it with a first file such as 0001_init.sql (bolide db sql > migrations/0001_init.sql).`)
    env.BOLIDE_MIGRATIONS = dir
  }
  const tsx = import.meta.resolve('tsx')
  const child = spawn(process.execPath, ['--import', tsx, '--input-type=module', '-e', scripts[command]], { cwd, env, stdio: 'inherit' })
  return new Promise((done, fail) => {
    child.once('error', fail)
    child.once('exit', (code) => done(code ?? 1))
  })
}

function configured(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as { bolide?: { schema?: unknown } }
    return typeof pkg.bolide?.schema === 'string' ? pkg.bolide.schema : undefined
  } catch {
    return undefined
  }
}
