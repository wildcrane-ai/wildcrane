export const PDF = 'application/pdf';
export const OFFICE_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

export type OfficeExtension = keyof typeof OFFICE_TYPES;

export function officeExtension(name: string): OfficeExtension | undefined {
  const ext = /\.[\w-]+$/.exec(name)?.[0].toLowerCase() as OfficeExtension;
  return Object.hasOwn(OFFICE_TYPES, ext) ? ext : undefined;
}

export function isDocumentPreview(key: string): boolean {
  return key.startsWith('wildcrane:document-preview/');
}

export function documentPreviewKey(artifact: string, version: number): string {
  return `wildcrane:document-preview/${artifact}/${version}.pdf`;
}
