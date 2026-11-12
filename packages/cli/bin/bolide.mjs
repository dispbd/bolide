#!/usr/bin/env node
// The package ships TypeScript sources until the build step lands, so load them through tsx.
import { register } from 'tsx/esm/api'

register()
const { run } = await import('../src/index.ts')
process.exitCode = await run(process.argv.slice(2))
