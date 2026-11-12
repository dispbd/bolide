import { BolideError } from './errors.ts'
import { defineService } from './service.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

export interface LogRecord {
  time: Date
  level: LogLevel
  msg: string
  fields: LogFields
}

export interface Logger {
  readonly level: LogLevel
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** True when records at `level` are written. Check it before building expensive fields. */
  enabled(level: LogLevel): boolean
  /** A logger that adds `fields` to every record. */
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  /** Records below this level are dropped. Default `info`. */
  level?: LogLevel
  /** `json`: one JSON object per line, for log collectors. `pretty`: readable lines for a terminal. Default `json`. */
  format?: 'json' | 'pretty'
  /** Where records go. Defaults to the console in the chosen format; pass a function to collect them (tests). */
  write?: (record: LogRecord) => void
  /** Fields added to every record. */
  fields?: LogFields
}

const levels: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(levels, value)
}

/** A structured logger. Fields are kept as values until a record is written. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  if (!isLogLevel(level)) throw new BolideError(`log level must be one of ${Object.keys(levels).join(', ')}, got "${level}".`)
  const format = options.format ?? 'json'
  const write = options.write ?? (format === 'pretty' ? writePretty : writeJson)
  const make = (base: LogFields): Logger => {
    const log = (at: LogLevel) => (msg: string, fields?: LogFields) => {
      if (levels[at] < levels[level]) return
      write({ time: new Date(), level: at, msg, fields: fields ? { ...base, ...fields } : base })
    }
    return {
      level,
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      enabled: (at) => levels[at] >= levels[level],
      child: (fields) => make({ ...base, ...fields }),
    }
  }
  return make(options.fields ?? {})
}

/** Errors become plain objects (with their cause), so they survive JSON.stringify. */
export function serializeError(e: unknown, depth = 0): unknown {
  if (!(e instanceof Error)) return e
  const out: Record<string, unknown> = { name: e.name, message: e.message, stack: e.stack }
  for (const [k, v] of Object.entries(e)) out[k] = v
  if (e.cause !== undefined && depth < 5) out.cause = serializeError(e.cause, depth + 1)
  if (e instanceof AggregateError && depth < 5) out.errors = e.errors.map((x) => serializeError(x, depth + 1))
  return out
}

function jsonLine(record: LogRecord) {
  const fields: LogFields = {}
  for (const [k, v] of Object.entries(record.fields)) fields[k] = serializeError(v)
  // Fixed keys go last so a field can't overwrite them.
  const line = { ...fields, time: record.time.toISOString(), level: record.level, msg: record.msg }
  try {
    return JSON.stringify(line)
  } catch {
    // Cycles or BigInt: keep the record, drop what can't be encoded.
    return JSON.stringify({ time: line.time, level: line.level, msg: line.msg, logError: 'fields are not serializable' })
  }
}

function writeJson(record: LogRecord) {
  const line = jsonLine(record)
  if (levels[record.level] >= levels.warn) console.error(line)
  else console.log(line)
}

const colors: Record<LogLevel, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }

/** `12:00:01.234 INFO  GET /users 200 3ms reqId=…`, with error stacks on the lines below. */
export function formatPretty(record: LogRecord, color = false) {
  const time = record.time.toISOString().slice(11, 23)
  const tag = record.level.toUpperCase().padEnd(5)
  const stacks: string[] = []
  const pairs = Object.entries(record.fields).map(([k, v]) => {
    if (v instanceof Error) {
      stacks.push(v.stack ?? `${v.name}: ${v.message}`)
      return `${k}=${v.name}`
    }
    return `${k}=${typeof v === 'string' ? v : safeJson(v)}`
  })
  const head = [time, color ? `${colors[record.level]}${tag}\x1b[0m` : tag, record.msg, ...pairs].join(' ')
  return [head, ...stacks.map((s) => s.replace(/^/gm, '    '))].join('\n')
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

function writePretty(record: LogRecord) {
  const p = (globalThis as { process?: { stdout?: { isTTY?: boolean } } }).process
  const line = formatPretty(record, p?.stdout?.isTTY === true)
  if (levels[record.level] >= levels.warn) console.error(line)
  else console.log(line)
}

/** The app's logger. `createApp({ logger })` sets it; by default it follows LOG_LEVEL and NODE_ENV. */
export const Log = defineService<Logger>({
  name: 'Log',
  factory: () => {
    throw new BolideError('Log is provided by createApp().')
  },
})

/** The id of the current request: the incoming `x-request-id` when it looks safe, otherwise a new UUID. */
export const RequestId = defineService<string>({
  name: 'RequestId',
  scope: 'request',
  factory: () => {
    throw new BolideError('RequestId is only available while handling a request.')
  },
})

/** The app's logger with the current request's id on every record. */
export const RequestLog = defineService({
  name: 'RequestLog',
  scope: 'request',
  inject: { log: Log, id: RequestId },
  factory: ({ log, id }) => log.child({ reqId: id }),
})
