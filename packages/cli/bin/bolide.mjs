#!/usr/bin/env node
import { existsSync } from 'node:fs'

// The published package ships only dist/. In a checkout, src/ exists and wins,
// so the binary always runs the code being edited, never a stale build.
const source = new URL('../src/index.ts', import.meta.url)
let cli
if (existsSync(source)) {
  const { register } = await import('tsx/esm/api')
  register()
  cli = await import(source.href)
} else {
  cli = await import(new URL('../dist/index.js', import.meta.url).href)
}
process.exitCode = await cli.run(process.argv.slice(2))
