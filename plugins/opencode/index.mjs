import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const recovery = 'WildCrane could not connect to its Runner. Check the network and Node.js 22+, then reload the plugin.'

// Own only the component connection; the shared Runner keeps its existing lock lifecycle.
function connection() {
  let current
  let opening
  let disposed = false
  const close = async () => {
    disposed = true
    await opening?.catch(() => {})
    await current?.close()
    current = undefined
  }
  const connect = () => {
    if (disposed) return Promise.reject(new Error('WildCrane plugin was unloaded. Reload OpenCode.'))
    if (current) return Promise.resolve(current)
    if (opening) return opening
    opening = (async () => {
      const client = new Client({ name: 'wildcrane-opencode', version: '0.1.21' })
      const transport = new StdioClientTransport({
        command: 'node',
        args: [path.join(root, 'server/dist/start.mjs'), 'opencode'],
        stderr: 'inherit',
        env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
      })
      client.onclose = () => { if (current === client) current = undefined }
      try {
        await client.connect(transport, { timeout: 90_000 })
        current = client
        return client
      } catch (error) {
        await transport.close()
        throw new Error(recovery, { cause: error })
      }
    })().finally(() => { opening = undefined })
    return opening
  }
  return {
    close,
    async tools() { return (await (await connect()).listTools()).tools },
    async call(name, args, context) {
      if (!context?.sessionID?.trim() || !context.directory) throw new Error('OpenCode session identity or directory is missing. Reload the WildCrane plugin and retry.')
      const signal = context.signal ?? context.abort
      signal?.throwIfAborted()
      const client = await connect()
      signal?.throwIfAborted()
      try {
        return await client.callTool({ name, arguments: args, _meta: {
          threadId: context.sessionID,
          'x-codex-turn-metadata': { workspaces: { [context.directory]: {} } },
        } }, undefined, { signal, timeout: 90_000 })
      } catch (error) {
        if (signal?.aborted) throw error
        throw new Error(recovery, { cause: error })
      }
    },
  }
}

function skills() {
  return ['discuss-goal', 'tasks', 'wildcrane'].map((name) => {
    const file = path.join(root, 'skills', name, 'SKILL.md')
    const source = fs.readFileSync(file, 'utf8')
    return {
      id: name === 'wildcrane' ? name : `wildcrane-${name}`, name: name === 'wildcrane' ? name : `wildcrane-${name}`, path: file,
      description: source.match(/^description: (.+)$/m)[1],
      content: source.replace(/^---\n[\s\S]*?\n---\n/, '').trim(),
    }
  })
}

// V1 reads configured paths after native folders. Keep user skills ahead of ours.
function userSkillPaths(directory, worktree) {
  const home = os.homedir()
  const roots = [process.env.OPENCODE_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'opencode')]
  const external = !['1', 'true'].includes(process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS)
  const names = external ? [...(['1', 'true'].includes(process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS) ? [] : ['.claude']), '.agents'] : []
  const paths = names.map((name) => path.join(home, name, 'skills'))
  const directories = []
  for (let dir = directory; ; dir = path.dirname(dir)) {
    directories.unshift(dir)
    if (dir === worktree || path.dirname(dir) === dir) break
  }
  for (const dir of directories) {
    roots.push(path.join(dir, '.opencode'))
    paths.push(...names.map((name) => path.join(dir, name, 'skills')))
  }
  return [...paths, ...roots.flatMap((root) => ['skill', 'skills'].map((name) => path.join(root, name)))].filter((dir) => fs.existsSync(dir))
}

const output = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

export default {
  id: 'wildcrane',
  async server({ directory = process.cwd(), worktree = directory } = {}) {
    const bridge = connection()
    try {
      const definitions = await bridge.tools()
      const native = Object.fromEntries(definitions.map((definition) => {
        const schema = z.fromJSONSchema(definition.inputSchema)
        return [definition.name, {
          description: definition.description,
          args: schema.shape,
          async execute(args, context) {
            await context.ask({ permission: definition.name, patterns: ['*'], always: ['*'], metadata: {} })
            return output(await bridge.call(definition.name, args, context))
          },
        }]
      }))
      // V1 discovers skills natively from paths supplied by the config hook.
      return {
        tool: native,
        config(config) {
          config.skills ??= {}
          config.skills.paths = [...new Set([path.join(root, 'v1-skills'), ...userSkillPaths(directory, worktree), ...(config.skills.paths ?? [])])]
        },
        dispose: () => bridge.close(),
      }
    } catch (error) { await bridge.close(); throw error }
  },
  async setup(ctx) {
    const bridge = connection()
    try {
      const definitions = await bridge.tools()
      const entries = skills()
      await ctx.skill.transform((editor) => {
        for (const skill of entries) if (!editor.get(skill.id)) editor.add(skill)
      })
      await ctx.tool.transform((editor) => {
        for (const definition of definitions) {
          if (editor.get(definition.name)) continue
          editor.add({
            name: definition.name, description: definition.description, input: definition.inputSchema,
            async execute(args, context) {
              await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
                source: { type: 'tool', messageID: context.messageID, id: context.id },
                action: definition.name, resources: ['*'], save: ['*'] })
              const session = await ctx.session.get({ sessionID: context.sessionID })
              const result = await bridge.call(definition.name, args, { ...context, directory: session.location.directory })
              return { content: output(result) }
            },
          })
        }
      })
      return () => bridge.close()
    } catch (error) { await bridge.close(); throw error }
  },
}
