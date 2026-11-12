import { BolideError, type StandardSchemaV1 } from '@bolide/core'
import { defineJob } from '@bolide/queue'
import { Mailer, prepareMail, type MailMessage } from './mailer.ts'

/** A message that can wait in a queue: attachments carry text (e.g. base64) rather than bytes. */
export type QueuedMail = MailMessage & { attachments?: readonly { filename: string; content: string; contentType?: string }[] }

/**
 * Checks a queued message with the same rules as `Mailer.send`, so a bad message fails
 * when it is enqueued, not later in the worker. `from` may be left to the mailer.
 */
const queuedMail: StandardSchemaV1<QueuedMail, QueuedMail> = {
  '~standard': {
    version: 1,
    vendor: 'bolide',
    validate(value) {
      if (typeof value !== 'object' || value === null) return { issues: [{ message: 'expected a mail message object' }] }
      const m = value as QueuedMail
      if (m.attachments?.some((a) => typeof a.content !== 'string')) {
        return { issues: [{ message: 'queued attachments need string content (encode bytes as base64)', path: ['attachments'] }] }
      }
      try {
        prepareMail(m, m.from ?? 'queued@bolide.invalid')
      } catch (e) {
        return { issues: [{ message: e instanceof BolideError ? e.message : String(e) }] }
      }
      return { value: m }
    },
  },
}

/**
 * Sends mail from the queue, with the queue's retries:
 * `queueModule({ jobs: [SendMail] })`, then `queue.enqueue(SendMail, { to, subject, text })`.
 * The mail module must be visible to the queue module (it is global).
 */
export const SendMail = defineJob({
  name: 'bolide.send-mail',
  schema: queuedMail,
  inject: { mailer: Mailer },
  retries: 5,
  backoff: (attempt) => Math.min(30_000 * 2 ** (attempt - 1), 3_600_000),
  handler: async (mail, { mailer }) => {
    await mailer.send(mail)
  },
})
