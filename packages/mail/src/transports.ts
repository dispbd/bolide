import { BolideError, type Logger } from '@bolide/core'
import type { MailTransport, OutgoingMail } from './mailer.ts'

export interface MemoryTransport extends MailTransport {
  /** Every message sent, oldest first. */
  readonly sent: OutgoingMail[]
  /** The last message sent to `address` (matched inside `"Name <address>"` too). */
  lastTo(address: string): OutgoingMail | undefined
}

/** Keeps messages in memory instead of sending them. For tests and local development. */
export function memoryTransport(): MemoryTransport {
  const sent: OutgoingMail[] = []
  return {
    sent,
    async send(mail) {
      sent.push(mail)
      return { id: `memory-${sent.length}` }
    },
    lastTo(address) {
      const has = (list: readonly string[]) => list.some((a) => a === address || a.endsWith(`<${address}>`))
      for (let i = sent.length - 1; i >= 0; i--) {
        const m = sent[i]!
        if (has(m.to) || has(m.cc) || has(m.bcc)) return m
      }
      return undefined
    },
  }
}

/** Logs each message (recipients, subject and text) instead of sending it. For local development. */
export function consoleTransport(log: Pick<Logger, 'info'> = { info: (msg, f) => console.log(msg, f) }): MailTransport {
  return {
    async send(mail) {
      log.info(`mail to ${mail.to.join(', ')}: ${mail.subject}`, { from: mail.from, cc: mail.cc, text: mail.text ?? '(html only)' })
    },
  }
}

/** The part of a nodemailer transporter the SMTP transport uses. */
export interface NodemailerLike {
  sendMail(options: Record<string, unknown>): Promise<{ messageId?: string }>
}

/**
 * Sends through SMTP with nodemailer: `smtpTransport(nodemailer.createTransport({ host, port, auth }))`.
 * nodemailer stays your dependency; Bolide only calls `sendMail`.
 */
export function smtpTransport(transporter: NodemailerLike): MailTransport {
  return {
    async send(mail) {
      const info = await transporter.sendMail({
        from: mail.from,
        to: [...mail.to],
        cc: [...mail.cc],
        bcc: [...mail.bcc],
        replyTo: mail.replyTo,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers: mail.headers,
        attachments: mail.attachments?.map((a) => ({
          filename: a.filename,
          content: typeof a.content === 'string' ? a.content : Buffer.from(a.content),
          contentType: a.contentType,
        })),
      })
      return { id: info.messageId }
    },
  }
}

export interface HttpTransportOptions {
  /** The provider's send endpoint. */
  url: string
  /** Usually the API key, e.g. `{ authorization: 'Bearer …' }`. */
  headers?: Record<string, string>
  /** Builds the provider's JSON body from the message. */
  body: (mail: OutgoingMail) => unknown
  /** Reads the message id from the provider's JSON answer. */
  id?: (response: unknown) => string | undefined
  /** Default 10s. */
  timeout?: number
}

/**
 * Sends through any JSON HTTP API (most mail providers have one), with `fetch`.
 * A non-2xx answer throws with the provider's message, so a queued send retries.
 */
export function httpTransport(options: HttpTransportOptions): MailTransport {
  return {
    async send(mail) {
      const res = await fetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(options.body(mail)),
        signal: AbortSignal.timeout(options.timeout ?? 10_000),
      })
      const text = await res.text()
      if (!res.ok) throw new BolideError(`mail provider answered ${res.status}: ${text.slice(0, 300)}`)
      let json: unknown
      try {
        json = text ? JSON.parse(text) : undefined
      } catch {
        json = undefined
      }
      return { id: options.id?.(json) }
    },
  }
}
