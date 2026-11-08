// What a plugin runs (#529): the component of the newest Runner on this computer, downloaded on
// first start. Everything else ships with the Runner.

import { pathToFileURL } from 'node:url'

import { useRunnerHome } from './home'
import { pluginEntry } from './launcher'

useRunnerHome()
const entry = await pluginEntry()
if (entry) await import(pathToFileURL(entry).href)
else {
  process.stderr.write('WildCrane could not download its Runner. Check the network, then restart.\n')
  process.exit(1)
}
