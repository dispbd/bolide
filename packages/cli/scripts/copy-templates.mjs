// Copies examples/* into templates/ so they ship with the CLI. npm drops .gitignore files from packages,
// so they travel as _gitignore and `bolide create` renames them back.
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

const examples = new URL('../../../examples/', import.meta.url).pathname
const templates = new URL('../templates/', import.meta.url).pathname
rmSync(templates, { recursive: true, force: true })
for (const name of ['todos']) {
  const to = join(templates, name)
  cpSync(join(examples, name), to, { recursive: true, filter: (src) => !['node_modules', 'dist'].includes(basename(src)) })
  if (existsSync(join(to, '.gitignore'))) renameSync(join(to, '.gitignore'), join(to, '_gitignore'))
}
