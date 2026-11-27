import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFilePath, isAssetRef, isLegacyAssetRef, isTaskAssetRef, taskAssetPath } from '../../../../artifact-sdk/src/internal/task-assets'
import { assertBoardStatePath, realPathOf } from './project'

const inside = (file: string, folder: string) => file.startsWith(folder + path.sep)

/** Resolve a card reference or a dependency relative to the file that names it. */
export function resolveBoardAsset(board: string, state: string, id: number | null, name: string, owner: string, dependency = false): string | null {
  const assets = path.join(state, 'assets')
  const folder = id === null ? assets : path.join(assets, String(id))
  assertBoardStatePath(name, state, id)
  if (/^file:/i.test(name)) {
    let local: string | undefined
    try { local = fileURLToPath(name) } catch { /* Invalid file URL. */ }
    if (local) assertBoardStatePath(local, state, id)
    throw new Error(`absolute path: ${name}`)
  }
  const decoded = decodeFilePath(name)
  if ((path.posix.isAbsolute(decoded) && !decoded.startsWith('//')) || path.win32.isAbsolute(decoded) && !decoded.startsWith('//')) {
    assertBoardStatePath(decoded, state, id)
    assertBoardStatePath(realPathOf(decoded), state, id)
    throw new Error(`absolute path: ${name}`)
  }

  const taskRef = isTaskAssetRef(name)
  let file: string
  if (taskRef) {
    if (dependency && isAssetRef(name)) throw new Error(`use a path relative to the preview file: ${name}`)
    const relative = id === null ? null : taskAssetPath(name, id)
    if (relative === null) {
      if (isLegacyAssetRef(name)) throw new Error(`outside the board: ${name}`)
      throw new Error(`expected asset:<path> within this task's asset folder: ${name}`)
    }
    file = path.resolve(folder, relative)
  } else {
    if (/^[a-z][\w+.-]*:/i.test(name) || name.startsWith('#') || name.startsWith('//')) return null
    file = path.resolve(path.dirname(owner), decoded)
  }
  const taskOnly = taskRef || inside(owner, folder)
  const roots = taskOnly ? [folder] : [board, folder]
  const realAssets = path.join(realPathOf(state), 'assets')
  const realFolder = id === null ? realAssets : path.join(realAssets, String(id))
  const realRoots = taskOnly ? [realFolder] : [realPathOf(board), realFolder]
  const real = realPathOf(file)
  assertBoardStatePath(file, state, id)
  assertBoardStatePath(real, state, id)
  if (!roots.some(root => inside(file, root))) throw new Error(`outside the board: ${name}`)
  if (!realRoots.some(root => inside(real, root))) throw new Error(`link outside the board: ${name}`)
  return file
}
