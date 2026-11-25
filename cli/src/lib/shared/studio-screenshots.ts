export const isStudioScreenshot = (file: string) => /^screenshots\/[\w.-]+\.(png|jpe?g|webp)$/.test(file)

export function studioScreenshotPath(url: string): string | undefined {
  try {
    const path = decodeURIComponent(url.split(/[?#]/, 1)[0]!).replace(/^\.\//, '')
    return isStudioScreenshot(path) ? path : undefined
  } catch {
    return undefined
  }
}
