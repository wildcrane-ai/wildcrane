// The agents the studios bring (#409): each Cloud studio's `agents/<name>/` files, keyed
// `<name>/<path>`. Official ones are read as built-ins; the workspace's own as the project's.

import { cloudAgentFiles } from '../agent/cloud-studios'

export const shippedAgentFiles = (): Record<string, string> => cloudAgentFiles().files

/** Whether an agent came with an official studio. */
export const officialAgent = (name: string): boolean => cloudAgentFiles().official.has(name)
