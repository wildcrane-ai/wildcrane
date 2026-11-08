// What a plugin runs (#529): the component of the newest Runner on this computer, downloaded on
// first start. Everything else ships with the Runner.

import { pathToFileURL } from 'node:url'

import { useRunnerHome } from './home'
import { pluginEntry } from './launcher'

/** The first Runner whose component knows each host; an older one would run it as Claude Code. */
const FIRST: Record<string, string> = { kimi: '0.6.35' }

useRunnerHome()
const entry = await pluginEntry(FIRST[process.argv[2] ?? ''])
if (entry) await import(pathToFileURL(entry).href)
else {
  process.stderr.write('WildCrane could not download its Runner. Check the network, then restart.\n')
  process.exit(1)
}
