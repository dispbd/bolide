import { parseArgs } from 'node:util'
import { create } from './create.ts'
import { dev } from './dev.ts'
import { CliError, UsageError } from './errors.ts'

export { create, type CreateOptions } from './create.ts'
export { dev, type DevOptions } from './dev.ts'
export { CliError } from './errors.ts'

const help = `Usage: bolide <command> [options]

Commands:
  create <dir>   Create a new Bolide project in <dir>
                 --local <path>  link @bolide/* from a local Bolide checkout
                 --force         write into a non-empty directory (existing files are kept)
  dev [entry]    Run the app and restart it when files change
                 (entry defaults to "bolide.entry" in package.json, then src/main.ts)
                 --port <n>      sets PORT for the app

  help           Show this message`

/** Runs the CLI and returns the exit code. `out` and `err` are swappable for tests. */
export async function run(argv: string[], out = console.log, err = console.error): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'create': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { local: { type: 'string' }, force: { type: 'boolean' } },
        })
        if (positionals.length !== 1) throw new UsageError('create needs exactly one directory, e.g. `bolide create my-app`.')
        const result = await create({ dir: positionals[0]!, local: values.local, force: values.force })
        if (result.kept.length) out(`Kept existing files: ${result.kept.join(', ')}`)
        out(`Created ${result.name} in ${result.dir}\n\nNext:\n  cd ${positionals[0]}\n  npm install\n  npm run dev`)
        return 0
      }
      case 'dev': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { port: { type: 'string' } },
        })
        if (positionals.length > 1) throw new UsageError('dev takes at most one entry file.')
        const port = values.port === undefined ? undefined : Number(values.port)
        if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) {
          throw new UsageError(`--port must be a port number, got "${values.port}".`)
        }
        const child = dev({ entry: positionals[0], port, log: out })
        return await child.exited
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        out(help)
        return 0
      default:
        throw new UsageError(`unknown command "${command}".`)
    }
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      err(`bolide: ${(e as Error).message}\n\n${help}`)
      return 2
    }
    if (e instanceof CliError) {
      err(`bolide: ${e.message}`)
      return 1
    }
    throw e
  }
}
