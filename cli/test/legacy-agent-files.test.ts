import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSpecAgent } from '../src/lib/agents/parse.ts'

const agentFile = (name: string, reads: string) => [
  '---', `name: ${name}`, 'description: Use when.', 'akb:', `  reads: ${reads}`, '---', '', 'Review the project.', '',
].join('\n')

describe('declaring a scheduled agent', () => {
  it('reads `akb.reads`, and refuses a value it does not know', () => {
    const read = parseSpecAgent(agentFile('night-auditor', 'chats'), 'AGENT.md', () => null)
    assert.ok('agent' in read)
    assert.equal(read.agent.reads, 'chats')
    const bad = parseSpecAgent(agentFile('night-auditor', 'tweets'), 'AGENT.md', () => null)
    assert.ok('problem' in bad)
    assert.match(bad.problem, /`archived-cards` or `chats` or `dismissals`$/)
  })

  it('rejects the retired `akb.reads: commits` value', () => {
    const read = parseSpecAgent(agentFile('night-auditor', 'commits'), 'AGENT.md', () => null)
    assert.ok('problem' in read)
  })

  it('refuses `akb.hook: schedule`, from before its studio listed it', () => {
    const file = agentFile('night-auditor', 'chats').replace('akb:', 'akb:\n  hook: schedule')
    const read = parseSpecAgent(file, 'AGENT.md', () => null)
    assert.ok('problem' in read)
    assert.match(read.problem, /declares `akb.hook`, which the board no longer reads/)
  })
})
