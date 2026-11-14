// Freeze the real preview renderer and isolated dependency lock into one retrievable studio file.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export async function buildMockupCheck() {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = await build({
    entryPoints: [path.join(cli, 'src/lib/check-mockup.ts')], bundle: true, write: false,
    absWorkingDir: cli, platform: 'node', format: 'esm', target: 'node18', packages: 'external', minify: true,
    loader: { '.css': 'text', '.json': 'json' }, legalComments: 'none',
    plugins: [{ name: 'tailwind-theme', setup(build) {
      build.onResolve({ filter: /^tailwindcss\/index.css$/ }, () => ({ path: path.join(cli, 'node_modules/tailwindcss/index.css') }))
    } }],
  })
  const payload = { 'runtime.mjs': result.outputFiles[0].text }
  for (const name of ['package.json', 'package-lock.json']) payload[name] = fs.readFileSync(path.join(cli, 'scripts/mockup-environment', name), 'utf8')
  const template = fs.readFileSync(path.join(cli, 'scripts/mockup-bootstrap.mjs'), 'utf8')
  return template.replace('__MOCKUP_PAYLOAD__', Buffer.from(JSON.stringify(payload)).toString('base64'))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../official/agents/ui-designer/scripts/check-mockup.mjs')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, await buildMockupCheck())
  console.log(`Wrote ${output}`)
}
