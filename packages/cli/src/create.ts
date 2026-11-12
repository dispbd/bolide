import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError } from './errors.ts'
import { packageFields, template } from './template.ts'

export interface CreateOptions {
  dir: string
  /**
   * Path to a local Bolide checkout: the new project depends on its packages
   * through `file:` links. Without it, the published versions are used.
   */
  local?: string
  /** Write into a directory that already has files. Existing files are kept, never overwritten. */
  force?: boolean
  /** `default` (an API with one module) or `todos` (Postgres, live sync and a React UI). */
  template?: string
}

export const templates = ['default', 'todos'] as const

/** Writes a new project. Refuses a non-empty directory unless `force` is set. */
export async function create(options: CreateOptions) {
  const dir = resolve(options.dir)
  const name = packageName(basename(dir))
  const local = options.local && resolve(options.local)
  const kind = options.template ?? 'default'
  if (!(templates as readonly string[]).includes(kind)) throw new CliError(`unknown template "${kind}". Pick one of: ${templates.join(', ')}.`)
  if (local && !existsSync(join(local, 'packages', 'core', 'package.json'))) {
    throw new CliError(`--local ${local} is not a Bolide checkout (no packages/core/package.json there).`)
  }
  const existing = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return []
    if (e.code === 'ENOTDIR') throw new CliError(`${dir} is a file. Pick a directory name.`)
    if (e.code === 'EACCES') throw new CliError(`can't read ${dir}: permission denied.`)
    throw e
  })
  if (existing.length && !options.force) {
    throw new CliError(`${dir} is not empty. Pick another directory or pass --force to write into it.`)
  }
  // Core and CLI are released together, so a project pins the version that generated it.
  const link = (pkg: string) => (local ? `file:${relative(dir, join(local, 'packages', pkg)).split(sep).join('/')}` : `^${cliVersion()}`)
  const files = kind === 'default' ? template({ name, core: link('core'), cli: link('cli') }) : await example(kind, name, link)
  const written: string[] = []
  const kept: string[] = []
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    // --force adds the scaffold around existing files; it never overwrites them.
    if (existsSync(target)) {
      kept.push(path)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    written.push(path)
  }
  const fields = kind === 'default' ? packageFields({ core: link('core'), cli: link('cli') }) : pick(JSON.parse(files['package.json']!), ['scripts', 'bolide', 'dependencies', 'devDependencies'])
  return { dir, name, template: kind, files: written, kept, packageFields: fields }
}

/** An app from examples/: shipped in templates/ by the build, read from the checkout when running from source. */
async function example(kind: string, name: string, link: (pkg: string) => string) {
  const shipped = fileURLToPath(new URL(`../templates/${kind}/`, import.meta.url))
  const root = existsSync(shipped) ? shipped : fileURLToPath(new URL(`../../../examples/${kind}/`, import.meta.url))
  const files: Record<string, string> = {}
  const walk = async (rel: string) => {
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(path)
      else files[path === '_gitignore' ? '.gitignore' : path] = await readFile(join(root, path), 'utf8')
    }
  }
  await walk('')
  const pkg = JSON.parse(files['package.json']!) as Record<string, unknown> & { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  pkg.name = name
  for (const deps of [pkg.dependencies, pkg.devDependencies]) for (const dep of Object.keys(deps ?? {})) if (dep.startsWith('@bolide/')) deps![dep] = link(dep.slice('@bolide/'.length))
  files['package.json'] = JSON.stringify(pkg, null, 2) + '\n'
  return files
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]))

/** npm package names are lowercase and URL-safe. */
function packageName(dirName: string) {
  const name = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|-+$/g, '')
  if (!name) throw new CliError(`can't derive a package name from "${dirName}". Use a directory name with letters or digits.`)
  return name
}

function cliVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return pkg.version
}
