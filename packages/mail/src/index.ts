export { Mailer, mailModule, MailTransport, prepareMail, type Attachment, type MailMessage, type MailModuleOptions, type OutgoingMail } from './mailer.ts'
export {
  consoleTransport,
  httpTransport,
  memoryTransport,
  smtpTransport,
  type HttpTransportOptions,
  type MemoryTransport,
  type NodemailerLike,
} from './transports.ts'
