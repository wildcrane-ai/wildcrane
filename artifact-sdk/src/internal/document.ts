export const PDF = 'application/pdf';
export const OFFICE_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

export type OfficeExtension = keyof typeof OFFICE_TYPES;

export function officeExtension(name: string): OfficeExtension | undefined {
  const ext = /\.(docx|pptx)$/i.exec(name)?.[0].toLowerCase();
  return ext as OfficeExtension | undefined;
}

export function isDocumentPreview(key: string): boolean {
  return key.startsWith('wildcrane:document-preview/');
}

export function documentPreviewKey(artifact: string, version: number): string {
  return `wildcrane:document-preview/${artifact}/${version}.pdf`;
}
