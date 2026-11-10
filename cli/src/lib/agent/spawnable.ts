// What to actually spawn for a command. Node cannot start a `.cmd` or `.bat` without a shell,
// and a shell would re-read every argument; so on Windows an npm or pnpm shim is followed to
// the script it runs and started with node, and any other batch file runs through cmd.exe
// with each argument escaped. Elsewhere the command is returned as given.

import fs from 'node:fs'
import path from 'node:path'
import type { SpawnOptions } from 'node:child_process'

export interface Spawnable {
  command: string
  args: string[]
  options: SpawnOptions
}

const META = /([()\][%!^"`<>&|;, *?])/g

/** One argument for a cmd.exe line that hands it on to a batch file, which reads it once more. */
export function cmdArg(arg: string): string {
  const quoted = `"${arg
    // cmd.exe cannot carry a line break inside an argument.
    .replace(/\r?\n|\r/g, ' ')
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(META, '^$1').replace(META, '^$1')
}

/** The `/c` line cmd.exe runs: the batch file, then its arguments. */
export function cmdLine(file: string, args: string[]): string {
  return `"${[file.replace(META, '^$1'), ...args.map(cmdArg)].join(' ')}"`
}

export interface Shim {
  script: string
  /** The node the shim prefers, beside it; else node from the PATH. */
  node: string
  env: Record<string, string>
}

/** The script an npm (cmd-shim) or pnpm `.cmd` runs with node; none for any other batch file. */
export function shimTarget(text: string, file: string): Shim | null {
  const dir = path.win32.dirname(file)
  const found = /"%(?:~dp0|dp0%)\\?([^"%]+)"\s+%\*/i.exec(text)
  // Both shims look for a node.exe beside them; a shim for sh or an .exe does not.
  if (!found || !/\\node\.exe"/i.test(text)) return null
  const script = path.win32.resolve(dir, found[1]!.replace(/\//g, '\\'))
  const local = path.win32.join(dir, 'node.exe')
  const nodePath = /SET "NODE_PATH=([^"]*)"/i.exec(text)?.[1]
  return { script, node: fs.existsSync(local) ? local : 'node', env: nodePath ? { NODE_PATH: nodePath } : {} }
}

/** Every file the PATH answers a bare name with, by PATHEXT. */
function onWindowsPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  for (const dir of (env[key] ?? '').split(';').filter(Boolean)) {
    for (const ext of exts) {
      const file = path.win32.join(dir, `${name}${ext.toLowerCase()}`)
      if (fs.existsSync(file)) return file
    }
  }
  return undefined
}

export function spawnable(command: string, args: string[], options: SpawnOptions = {}, platform: NodeJS.Platform = process.platform): Spawnable {
  if (platform !== 'win32') return { command, args, options }
  const env = options.env ?? process.env
  const file = path.extname(command) || /[\\/]/.test(command) ? command : onWindowsPath(command, env) ?? command
  const ext = path.extname(file).toLowerCase()
  const hidden: SpawnOptions = { ...options, windowsHide: true, shell: false }
  if (ext !== '.cmd' && ext !== '.bat') return { command: file, args, options: hidden }
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    // Unreadable: cmd.exe says what is wrong.
  }
  const shim = shimTarget(text, file)
  if (shim) {
    return { command: shim.node, args: [shim.script, ...args], options: { ...hidden, env: { ...env, ...shim.env } } }
  }
  return {
    command: env.ComSpec || process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', cmdLine(file, args)],
    options: { ...hidden, windowsVerbatimArguments: true },
  }
}
