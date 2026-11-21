import fs from 'node:fs'

// Runner sources import JSON as text. Bundled packages expect parsed JSON.
export const packageJsonPlugin = {
  name: 'package-json',
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/].*\.json$/ }, args => ({
      contents: fs.readFileSync(args.path, 'utf8'),
      loader: 'json',
    }))
  },
}
