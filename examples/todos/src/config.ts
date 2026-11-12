import { defineConfig } from '@bolide/core'
import * as v from 'valibot'

/** Typed settings, read from the environment and checked at boot. */
export const ServerConfig = defineConfig({
  name: 'ServerConfig',
  schema: v.object({ port: v.pipe(v.optional(v.string(), '3000'), v.transform(Number), v.integer()) }),
  load: (env) => ({ port: env.PORT }),
})
