#!/usr/bin/env node
let cli
try {
  cli = await import('../dist/index.js')
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e
  // An unbuilt checkout: run the TypeScript sources through tsx.
  const { register } = await import('tsx/esm/api')
  register()
  cli = await import('../src/index.ts')
}
process.exitCode = await cli.run(process.argv.slice(2))
