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
  return new Promise<{ port: number; close(): Promise<void> }>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: options.port ?? 3000, hostname: options.hostname }, (info) => {
      server.off('error', reject)
      const signals = ['SIGINT', 'SIGTERM'] as const
      const onSignal = () => {
        close().catch((e) => {
          console.error('[bolide] shutdown failed', e)
          process.exitCode = 1
        })
      }
      let closing: Promise<void> | undefined
      const close = () =>
        (closing ??= (async () => {
          for (const signal of signals) process.off(signal, onSignal)
          await new Promise<void>((done) => server.close(() => done()))
          await app.close()
        })())
      if (options.handleSignals ?? true) {
        for (const signal of signals) process.once(signal, onSignal)
      }
      resolve({ port: info.port, close })
    })
    // e.g. EADDRINUSE: fail the startup instead of leaving the promise pending forever
    server.once('error', reject)
  })
}
