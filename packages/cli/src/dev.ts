import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CliError } from './errors.ts'

export interface DevOptions {
  /** Entry file. Defaults to `bolide.entry` in package.json, then `src/main.ts`. */
  entry?: string
  /** Sets PORT for the app. */
  port?: number
  cwd?: string
  log?: (line: string) => void
}

/**
 * Runs the entry with Node's built-in watch mode and tsx for TypeScript.
 * Node restarts the process when the entry or anything it imports changes.
 */
export function dev(options: DevOptions = {}) {
  const cwd = options.cwd ?? process.cwd()
  const entry = resolve(cwd, options.entry ?? configuredEntry(cwd) ?? 'src/main.ts')
  if (!existsSync(entry)) {
    throw new CliError(`entry ${entry} does not exist. Pass one (\`bolide dev src/server.ts\`) or set "bolide": { "entry": ... } in package.json.`)
  }
  // Resolved from this package, so the project doesn't need its own tsx.
  const tsx = import.meta.resolve('tsx')
  const env = { ...process.env, ...(options.port === undefined ? {} : { PORT: String(options.port) }) }
  options.log?.(`bolide dev: ${entry} (restarts on change, Ctrl+C to stop)`)
  const child = spawn(process.execPath, ['--watch', '--import', tsx, entry], { cwd, env, stdio: 'inherit' })

  const forward = (signal: NodeJS.Signals) => child.kill(signal)
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)
  const cleanup = () => {
    process.off('SIGINT', forward)
    process.off('SIGTERM', forward)
  }
  const exited = new Promise<number>((done, fail) => {
    // A failed spawn emits 'error' and no 'exit', so both paths clean up.
    child.once('error', (e) => (cleanup(), fail(e)))
    child.once('exit', (code, signal) => (cleanup(), done(code ?? (signal ? 128 + signalNumber(signal) : 1))))
  })
  return { child, exited, stop: () => (child.kill('SIGTERM'), exited) }
}

function configuredEntry(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as { bolide?: { entry?: unknown } }
    return typeof pkg.bolide?.entry === 'string' ? pkg.bolide.entry : undefined
  } catch {
    return undefined
  }
}

function signalNumber(signal: NodeJS.Signals) {
  return { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal as string] ?? 0
}
