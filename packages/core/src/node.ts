import { serve } from '@hono/node-server'
import type { App } from './app.ts'

export interface ListenOptions {
  port?: number
  hostname?: string
  /** Close the server and the app on SIGINT/SIGTERM. Default true. */
  handleSignals?: boolean
}

/** Serves an app on Node.js. Other runtimes use `app.fetch` directly. */
export function listen(app: App, options: ListenOptions = {}) {
  return new Promise<{ port: number; close(): Promise<void> }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: options.port ?? 3000, hostname: options.hostname }, (info) => {
      let closing: Promise<void> | undefined
      const close = () =>
        (closing ??= new Promise<void>((done) => server.close(() => done())).then(() => app.close()))
      if (options.handleSignals ?? true) {
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void close())
      }
      resolve({ port: info.port, close })
    })
  })
}
