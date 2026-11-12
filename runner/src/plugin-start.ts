// What a plugin runs (#529): the component of the newest Runner on this computer, downloaded on
// first start. Everything else ships with the Runner.

import './startup'
import { pathToFileURL } from 'node:url'

// Windows starts this with whatever node the PATH has (server/bin/wildcrane.cmd).
if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write('WildCrane needs Node.js 22 or later. Install it from https://nodejs.org, then restart.\n')
  process.exit(1)
}
const { useRunnerHome } = await import('./home')
const { pluginEntry } = await import('./launcher')

/** The first Runner whose component knows each host; an older one would run it as Claude Code. */
const FIRST: Record<string, string> = { kimi: '0.6.35', grok: '0.6.53' }

useRunnerHome()
const entry = await pluginEntry(FIRST[process.argv[2] ?? ''])
if (entry) await import(pathToFileURL(entry).href)
else {
  process.stderr.write('WildCrane could not download its Runner. Check the network, then restart.\n')
  process.exit(1)
}
