import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { CliError } from './errors.ts'
import { template } from './template.ts'

export interface CreateOptions {
  dir: string
  /**
   * Path to a local Bolide checkout: the new project depends on its packages
   * through `file:` links. Without it, the published versions are used.
   */
  local?: string
  /** Write into a directory that already has files. */
  force?: boolean
}

/** Writes a new project. Refuses a non-empty directory unless `force` is set. */
export async function create(options: CreateOptions) {
  const dir = resolve(options.dir)
  const name = packageName(basename(dir))
  const local = options.local && resolve(options.local)
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
  const files = template({ name, core: link('core'), cli: link('cli') })
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return { dir, name, files: Object.keys(files) }
}

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
