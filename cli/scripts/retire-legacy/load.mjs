import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
export async function loadConverter() {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./convert.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}
