const PREFIX = 'asset:';
const LEGACY = '.assets/';

export const isAssetRef = (source: string) => source.startsWith(PREFIX);
export const isLegacyAssetRef = (source: string) => source.startsWith(LEGACY);
export const isTaskAssetRef = (source: string) => isAssetRef(source) || isLegacyAssetRef(source);

export function decodeFilePath(source: string): string {
  try { return decodeURIComponent(source); } catch { return source; }
}

export const assetRef = (file: string) => PREFIX + file.split('/').map(encodeURIComponent).join('/');

/** The asset-folder path encoded by a card reference. An id checks legacy ownership. */
export function taskAssetPath(source: string, id?: number): string | null {
  const legacy = isLegacyAssetRef(source);
  const name = legacy ? /^\.assets\/([1-9]\d*)\/(.+)$/.exec(source) : null;
  if (legacy && (!name || (id !== undefined && name[1] !== String(id)))) return null;
  if (!legacy && !isAssetRef(source)) return null;
  const file = decodeFilePath(name ? name[2]! : source.slice(PREFIX.length));
  if (/[\\:\u0000-\u001f]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return file;
}

/** Resolve a dependency against its owning asset, without stepping above the task folder. */
export function relativeAssetRef(source: string, owner: string): string | null {
  const file = taskAssetPath(owner);
  if (file === null) return null;
  const relative = decodeFilePath(source);
  if (relative.startsWith('/') || /[\\:\u0000-\u001f]/.test(relative)) return null;
  const parts = file.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? assetRef(parts.join('/')) : null;
}
