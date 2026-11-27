import { taskAssetPath } from './task-assets';
import { manifestOf, type Manifest } from './manifest';

const CSS: Manifest = {
  name: 'css',
  types: ['css'],
  references: [{ web: 'css' }],
};

export const fileManifest = (type: string, name: string): Manifest | undefined =>
  type === 'asset' && /\.css$/i.test(name) ? CSS : manifestOf(type);

export function encodeFileReferencePath(parts: readonly string[]): string {
  return parts.map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16))).join('/');
}

export function splitFileReference(src: string): [string, string] {
  const end = src.search(/[?#]/);
  return end < 0 ? [src, ''] : [src.slice(0, end), src.slice(end)];
}

export function fileNameOf(src: string): string {
  const [source] = splitFileReference(src);
  return (taskAssetPath(source) ?? source).split('/').at(-1)!;
}

export function relativeFileReference(src: string, owner: string): string {
  const parts = owner.split('/').slice(0, -1);
  for (const part of src.split('/')) {
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
