import { parse } from 'smol-toml'
import { obj, type Json } from '../../cli/src/lib/agent/wire/json'

export function mcpEnvironment(config: Json, defaults: Json): void {
  const servers = obj(config.mcp_servers)
  const names = new Set([...Object.keys(defaults), ...Object.keys(servers)])
  for (const key of Object.keys(config)) {
    const name = /^mcp_servers\.([^.]+)\./.exec(key)?.[1]
    if (name) names.add(name)
  }
  for (const name of names) {
    const key = `mcp_servers.${name}.env`
    const explicit = Object.fromEntries(Object.entries(config).filter(([k]) => k.startsWith(key + '.')).map(([k, value]) => [k.slice(key.length + 1), value]))
    config[key] = { ...obj(obj(defaults[name]).env), ...obj(obj(servers[name]).env), ...obj(config[key]), ...explicit, ...obj(config['shell_environment_policy.set']) }
  }
}

/** Move command overrides and job-local environment off the shared process. */
export function threadConfig(argv: string[], env: NodeJS.ProcessEnv): Json {
  const config: Json = {}
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--enable' || flag === '--disable') { config[`features.${argv[++i]}`] = flag === '--enable'; continue }
    if (flag !== '-c' && flag !== '--config') throw Error('Unsupported shared Codex option.')
    const pair = argv[++i] ?? ''
    const at = pair.indexOf('=')
    if (at < 1) throw Error('Invalid Codex configuration override.')
    const key = pair.slice(0, at), value = pair.slice(at + 1).trim()
    try { config[key] = parse(`value = ${value}`).value }
    catch { config[key] = value }
  }
  const local = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined &&
    key !== 'OPENAI_API_KEY' && key !== 'WILDCRANE_FLOW_WORKER' && (process.env[key] !== value || /^(KANBAN_|AI4KANBAN_|WILDCRANE_|PATH$)/.test(key))))
  config['shell_environment_policy.set'] = { ...obj(config['shell_environment_policy.set']), ...local }
  return config
}

export function providerCredentials(config: Json, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const credentials: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(config)) if (/^model_providers\..+\.env_key$/.test(key) && typeof value === 'string') {
    if (!env[value]) throw Error('The Codex provider credential is missing.')
    credentials[value] = env[value]
  }
  return credentials
}

export function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}=${tomlValue(v)}`).join(',')}}`
  return JSON.stringify(value)
}
