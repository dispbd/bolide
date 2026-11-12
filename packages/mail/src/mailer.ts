import { bind, BolideError, defineModule, defineService, Log, type Logger, type Module, type Service } from '@bolide/core'

export interface Attachment {
  filename: string
  content: string | Uint8Array
  contentType?: string
}

export interface MailMessage {
  /** One address or several. `"Ann <ann@example.com>"` and `ann@example.com` both work. */
  to: string | readonly string[]
  cc?: string | readonly string[]
  bcc?: string | readonly string[]
  /** Defaults to `mailModule({ from })`. */
  from?: string
  replyTo?: string
  subject: string
  text?: string
  html?: string
  headers?: Readonly<Record<string, string>>
  attachments?: readonly Attachment[]
}

/** A message after checks: addresses are lists and `from` is set. */
export interface OutgoingMail extends Omit<MailMessage, 'to' | 'cc' | 'bcc' | 'from'> {
  to: readonly string[]
  cc: readonly string[]
  bcc: readonly string[]
  from: string
}

/** Delivers a checked message. Return the provider's message id when there is one. */
export interface MailTransport {
  send(mail: OutgoingMail): Promise<{ id?: string } | void>
}

export interface Mailer {
  /** Checks the message, fills in `from`, and hands it to the transport. */
  send(message: MailMessage): Promise<{ id?: string }>
}

// Loose on purpose: real validation is the mail server's job. This catches typos and header injection.
const address = /^(?:[^<>\r\n]*<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/

const list = (v: string | readonly string[] | undefined) => (v === undefined ? [] : typeof v === 'string' ? [v] : [...v])

/** Validates a message and fills in the defaults. Throws a BolideError that names the bad field. */
export function prepareMail(message: MailMessage, defaultFrom?: string): OutgoingMail {
  const fail = (why: string): never => {
    throw new BolideError(`mail "${message.subject ?? ''}": ${why}`)
  }
  const from = message.from ?? defaultFrom ?? fail('no from address. Set it on the message or with mailModule({ from }).')
  const mail: OutgoingMail = { ...message, to: list(message.to), cc: list(message.cc), bcc: list(message.bcc), from }
  if (!mail.to.length && !mail.cc.length && !mail.bcc.length) fail('no recipients.')
  for (const [field, values] of [['to', mail.to], ['cc', mail.cc], ['bcc', mail.bcc], ['from', [from]], ['replyTo', list(message.replyTo)]] as const) {
    for (const v of values) if (!address.test(v.trim())) fail(`${field} "${v}" is not an email address.`)
  }
  if (typeof mail.subject !== 'string' || /[\r\n]/.test(mail.subject)) fail('the subject must be one line of text.')
  if (mail.text === undefined && mail.html === undefined) fail('add text or html.')
  for (const [k, v] of Object.entries(mail.headers ?? {})) {
    if (!/^[!-9;-~]+$/.test(k) || /[\r\n]/.test(v)) fail(`header "${k}" is not a valid one-line header.`)
  }
  for (const a of mail.attachments ?? []) if (!a.filename || /[\r\n"]/.test(a.filename)) fail(`attachment filename "${a.filename}" is not valid.`)
  return mail
}

/** The transport `Mailer` uses: set it with `mailModule({ transport })`. */
export const MailTransport = defineService<MailTransport>({
  name: 'MailTransport',
  factory: () => {
    throw new BolideError('MailTransport is provided by mailModule({ transport }).')
  },
})

/** The app's mailer. Provide it with `mailModule()`. */
export const Mailer = defineService<Mailer>({
  name: 'Mailer',
  factory: () => {
    throw new BolideError('Mailer is provided by mailModule().')
  },
})

function createMailer(transport: MailTransport, log: Logger, from?: string): Mailer {
  return {
    async send(message) {
      const mail = prepareMail(message, from)
      const result = (await transport.send(mail)) ?? {}
      log.debug('mail sent', { to: mail.to.length + mail.cc.length + mail.bcc.length, subject: mail.subject, id: result.id })
      return result
    },
  }
}

export interface MailModuleOptions {
  /** A transport, or a service that builds one (for SMTP settings from config). */
  transport: MailTransport | Service<MailTransport, any>
  /** Default sender, e.g. `"Shop <noreply@shop.example>"`. */
  from?: string
  /** Modules whose exports a transport service needs. */
  imports?: readonly Module[]
}

/** A global module providing `Mailer` (and `MailTransport`). */
export function mailModule(options: MailModuleOptions): Module {
  if (options.from !== undefined && !address.test(options.from)) throw new BolideError(`mailModule from "${options.from}" is not an email address.`)
  const t = options.transport
  if (!t) throw new BolideError('mailModule needs a transport, e.g. memoryTransport() in tests or smtpTransport(nodemailer.createTransport(...)).')
  const isService = (t as { kind?: unknown }).kind === 'service'
  const impl = defineService({
    name: 'Mailer',
    inject: { transport: MailTransport, log: Log },
    factory: ({ transport, log }) => createMailer(transport, log.child({ battery: 'mail' }), options.from),
  })
  return defineModule({
    name: 'mail',
    global: true,
    imports: options.imports,
    providers: [bind(MailTransport, isService ? { useService: t as Service<MailTransport, any> } : { useValue: t as MailTransport }), bind(Mailer, { useService: impl })],
    exports: [Mailer, MailTransport],
  })
}
