# @bolide/mail

Sending mail from Bolide apps: one `Mailer` service, transports for tests, development, SMTP and HTTP mail APIs, and a queue job for sending in the background with retries.

```ts
import { Mailer, mailModule, smtpTransport } from '@bolide/mail'
import nodemailer from 'nodemailer'

const app = await createApp({
  modules: [mailModule({ transport: smtpTransport(nodemailer.createTransport(process.env.SMTP_URL)), from: 'Shop <noreply@shop.example>' }), users],
})

// in a service that injects { mailer: Mailer }
await mailer.send({ to: user.email, subject: 'Welcome', text: 'Hi!', html: '<p>Hi!</p>' })
```

## Checks

`send` refuses a message before it reaches the transport when it has no recipients, no `from` (set one on `mailModule`), an address that isn't one, a subject or header with a line break (header injection), or neither `text` nor `html`. The error names the field.

## Transports

| Transport | Use |
|---|---|
| `memoryTransport()` | Tests: `sent` lists every message, `lastTo(address)` finds the latest one to someone. |
| `consoleTransport(log?)` | Development: logs recipients, subject and text. |
| `smtpTransport(transporter)` | SMTP through nodemailer (your dependency): pass `nodemailer.createTransport(...)`. |
| `httpTransport({ url, headers, body, id })` | Any JSON mail API over `fetch`: map the message to the provider's body. A non-2xx answer throws with the provider's message. |

A transport can also be a service, so its settings come from `defineConfig`: `mailModule({ transport: Smtp, imports: [configModule] })`.

## Sending later

```ts
import { SendMail } from '@bolide/mail/queue'

queueModule({ jobs: [SendMail] })
await queue.enqueue(SendMail, { to, subject, text })
```

The job checks the message when it is enqueued, then sends it from the worker with 5 retries (30s, 1m, 2m...). Queued attachments carry string content (base64 for bytes). `@bolide/queue` is an optional peer dependency, needed only for this entry.
