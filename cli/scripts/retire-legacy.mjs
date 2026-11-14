#!/usr/bin/env node
// One release operation, never imported by the CLI or Runner.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./retire-legacy/main.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false })
await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
