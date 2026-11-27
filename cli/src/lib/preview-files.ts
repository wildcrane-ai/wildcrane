// 卡片预览引用的文件：与 Runner 上传共用 SDK 的依赖收集，在会话结束前报出缺失、越界和不符合声明的内容。

import fs from 'node:fs'
import { collectSources } from '../../../artifact-sdk/src/internal/collect'
import { splitFileReference } from '../../../artifact-sdk/src/internal/file-references'
import { isLegacyAssetRef, isTaskAssetRef } from '../../../artifact-sdk/src/internal/task-assets'
import { bodyReferences } from '../../../artifact-sdk/src/internal/references'
import { referenceText } from './draw-mockup'
import { resolveBoardAsset } from './machine/asset-path'
import { InvalidBoardStatePath } from './machine/project'
import { BOARD_STATE, KANBAN, rel } from './paths'
import type { ContractError } from './spec-contract'

/** Validate local paths and the files reached by previews. */
export async function validatePreviewFiles(card: string, id: number, text: string, warn?: (message: string) => void): Promise<ContractError[]> {
  const errors: ContractError[] = []
  const lines = new Map<string, Set<number>>()
  const sources = bodyReferences(text, (src, line) => {
    const [file] = splitFileReference(src)
    if (!lines.has(file)) lines.set(file, new Set())
    lines.get(file)!.add(line)
  })
  const warnings = new Set<string>()
  const fileLines = new Map<string, string[]>()
  const lineOf = (file: string, source: string) => {
    let content = fileLines.get(file)
    if (!content) {
      content = fs.readFileSync(file, 'utf8').split('\n')
      fileLines.set(file, content)
    }
    return Math.max(1, content.findIndex(line => line.includes(source)) + 1)
  }
  const graph = await collectSources(sources, card, {
    resolve: (src, owner) => {
      const dependency = owner !== card
      try {
        const file = resolveBoardAsset(KANBAN, BOARD_STATE, id, src, owner, dependency)
        if (!file) return null
        if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error('no such file')
        if (warn && isLegacyAssetRef(src)) {
          const locations = dependency
            ? [lineOf(owner, src)]
            : lines.get(src) ?? []
          const replacement = dependency ? 'a path relative to this file' : 'asset:<path>'
          for (const line of locations) warnings.add(`${rel(owner)}:${line} [legacy-asset-reference] ${src} is deprecated. Use ${replacement}.`)
        }
        return { key: fs.realpathSync(file), file }
      } catch (error) {
        if (dependency) {
          if (error instanceof Error && /^(?:link )?outside the board:/.test(error.message)) {
            throw new Error("outside this card's files")
          }
          throw error
        }
        const rule = error instanceof InvalidBoardStatePath ? error.kind : 'asset-reference'
        const message = error instanceof Error ? error.message : String(error)
        if (rule !== 'asset-reference' || isTaskAssetRef(src) || /^absolute path:/.test(message)) {
          for (const line of lines.get(src) ?? []) errors.push({ file: rel(card), line, rule, message: `${src}: ${message}. Fix the reference or add the file.` })
          lines.delete(src)
        }
        return null
      }
    },
    read: referenceText,
    retained: () => [],
  })
  for (const message of warnings) warn?.(message)
  const kinds = new Map(graph.map((n) => [n.key, n.kind]))
  for (const node of graph) {
    for (const p of node.problems) {
      errors.push({ file: rel(node.file ?? card), line: p.line ?? (p.at && node.file ? lineOf(node.file, JSON.stringify(p.src)) : 1), rule: 'preview-file', message: `${p.at ? `${p.at}: ` : ''}${p.src}: ${p.message}. Fix the reference or add the file.` })
    }
    // A storyboard or compare holds files, never another compare, nor a storyboard in a storyboard (#526).
    if (node.kind !== 'storyboard' && node.kind !== 'compare') continue
    for (const [src, key] of node.dependencies) {
      const kind = kinds.get(key)
      if (kind === 'compare' || (node.kind === 'storyboard' && kind === 'storyboard')) {
        errors.push({ file: rel(node.file ?? card), line: 1, rule: 'preview-nesting', message: `${src} is a ${kind}, which cannot go inside a ${node.kind}. Name its files directly.` })
      }
    }
  }
  return errors
}
