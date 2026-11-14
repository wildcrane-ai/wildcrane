// Runs from the isolated environment prepared by the UI Designer's standalone script.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { drawMockup, MOCKUP_IMPORTS } from './draw-mockup'
import { renderError } from './preview-validation'
import { manifestOf, mapReferences } from '../../../artifact-sdk/src/internal/manifest'
import { TYPES } from '../../../artifact-sdk/src/internal/references'

const CODE = /\.(?:[cm]?js|jsx|tsx?)$/i
const FORBIDDEN = /^(?:fetch|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|setTimeout|setInterval|requestAnimationFrame|use[A-Z]\w*)$/

function contained(file: string, root: string): string {
  const real = fs.realpathSync(file)
  if (!real.startsWith(root + path.sep)) throw new Error(`${file}: outside the mockup's folder`)
  if (!fs.statSync(real).isFile()) throw new Error(`${file}: not a file`)
  return real
}

function local(id: string, owner: string, root: string): string {
  if (!id.startsWith('.')) throw new Error(`${owner}: unsupported import ${id}`)
  const base = path.resolve(path.dirname(owner), id)
  const tries = path.extname(base) ? [base] : [base, ...['.tsx', '.ts', '.jsx', '.js', '.mjs'].flatMap(ext => [base + ext, path.join(base, 'index' + ext)])]
  const file = tries.find(f => fs.statSync(f, { throwIfNoEntry: false })?.isFile())
  if (!file) throw new Error(`${owner}: no such file: ${id}`)
  return contained(file, root)
}

export function checkStaticMockupCode(file: string, text: string, inline = false): ts.SourceFile {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JS)
  const fail = (node: ts.Node, reason: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
    throw new Error(`${file}:${line + 1}:${character + 1}: ${reason}`)
  }
  const walk = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && /^use(?:[A-Z]|$)/.test((node.propertyName ?? node.name).text)) fail(node, 'remove React hooks')
    if (ts.isStringLiteral(node) && node.text === 'use client') fail(node, 'remove use client')
    if (ts.isJsxAttribute(node) && /^(?:on[A-Z]|ref$)/.test(node.name.getText(source))) fail(node, 'remove interactive handlers')
    if (!inline && ts.isPropertyAssignment(node) && /^(?:on[A-Z]|ref$)/.test(node.name.getText(source))) fail(node, 'remove interactive handlers')
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isElementAccessExpression(node.expression) && ts.isStringLiteral(node.expression.argumentExpression) ? node.expression.argumentExpression.text : node.expression.getText(source)
      if (FORBIDDEN.test(name) && !(inline && /^(?:requestAnimationFrame|setTimeout|setInterval)$/.test(name))) fail(node, `remove ${name}`)
      if (name === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword) fail(node, 'use static imports')
    }
    if (ts.isNewExpression(node) && /^(?:XMLHttpRequest|WebSocket|EventSource|Worker)$/.test(node.expression.getText(source))) fail(node, 'no network or workers')
    if (ts.isIdentifier(node) && /^(?:localStorage|sessionStorage|indexedDB)$/.test(node.text)) fail(node, 'no storage')
    ts.forEachChild(node, walk)
  }
  walk(source)
  return source
}

export function checkMockupTypes(files: string[], root: string, work: string): void {
  root = fs.realpathSync(root)
  files = files.map(file => contained(file, root))
  const mirror = path.join(work, 'source')
  fs.rmSync(mirror, { recursive: true, force: true })
  fs.mkdirSync(mirror, { recursive: true })
  for (const file of files) {
    const target = path.join(mirror, path.relative(root, file))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file, target)
  }
  const shim = path.join(mirror, 'preview.d.ts')
  fs.writeFileSync(shim, `declare module '*.css' {}\ndeclare module 'next/link' { import type {ComponentType, AnchorHTMLAttributes} from 'react'; const Link: ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & {prefetch?: boolean}>; export default Link }\ndeclare module 'next/image' { import type {ComponentType, ImgHTMLAttributes} from 'react'; const Image: ComponentType<ImgHTMLAttributes<HTMLImageElement> & {fill?: boolean; priority?: boolean}>; export default Image }\ndeclare module 'next/navigation' { export function useRouter(): never; export function usePathname(): string; export function useSearchParams(): URLSearchParams; export function useParams(): Record<string,string>; export function redirect(url: string): never; export function notFound(): never; }\n`)
  const program = ts.createProgram([...files.filter(f => CODE.test(f)).map(f => path.join(mirror, path.relative(root, f))), shim], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, noEmit: true, allowJs: true, checkJs: true,
    types: ['react', 'react-dom'], typeRoots: [path.join(work, 'node_modules/@types')],
  })
  const problems = ts.getPreEmitDiagnostics(program)
  if (problems.length) throw new Error(problems.map(d => {
    const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null
    const file = d.file ? path.join(root, path.relative(mirror, d.file.fileName)) : root
    return `${file}${at ? `:${at.line + 1}:${at.character + 1}` : ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`
  }).join('\n'))
}

async function pageFor(entry: string, work: string): Promise<string> {
  entry = fs.realpathSync(entry)
  if (!/\.(?:html|tsx)$/i.test(entry)) throw new Error(`${entry}: expected an HTML or TSX entry`)
  const root = fs.realpathSync(path.dirname(entry))
  contained(entry, root)
  const cssParser = 'postcss'
  const postcss = await import(cssParser)
  const files = new Set<string>()
  const visit = (file: string): void => {
    if (files.has(file)) return
    if (files.size >= 60) throw new Error(`${file}: more than 60 dependencies`)
    files.add(file)
    if (file.endsWith('.css')) {
      const css = fs.readFileSync(file, 'utf8')
      postcss.parse(css, { from: file })
      for (const match of css.matchAll(/@import\s+["']([^"']+)["']/g)) {
        if (match[1] === 'tailwindcss' || match[1]!.startsWith('tailwindcss/')) continue
        visit(local(match[1]!, file, root))
      }
      return
    }
    if (!CODE.test(file)) return
    const source = checkStaticMockupCode(file, fs.readFileSync(file, 'utf8'))
    for (const node of source.statements) {
      const spec = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : undefined
      if (!spec || !ts.isStringLiteral(spec)) continue
      if (spec.text.startsWith('.')) {
        let target: string
        try { target = local(spec.text, file, root) }
        catch (error) { throw new Error(`${file}:${source.getLineAndCharacterOfPosition(spec.pos).line + 1}: ${error instanceof Error ? error.message : String(error)}`) }
        visit(target)
      }
      else if (!MOCKUP_IMPORTS.has(spec.text)) throw new Error(`${file}:${source.getLineAndCharacterOfPosition(spec.pos).line + 1}: unsupported import ${spec.text}`)
    }
  }
  visit(entry)
  if (/\.tsx$/i.test(entry)) checkMockupTypes([...files], root, work)
  let html = await drawMockup(entry)
  // Use the upload manifest: files named only inside scripts are deliberately unreachable.
  const assets = new Map<string, string>()
  const checkResources = (text: string, owner: string): void => {
    if (/(?:\b(?:src|poster|srcset|href)\s*=\s*["']|url\(\s*["']?)(https?:|\/\/)/i.test(text.replace(/<a\b[^>]*>/gi, ''))) throw new Error(`${owner}: remote resources cannot render offline`)
    if (/<[a-z][^<>]*\son[a-z]+\s*=/i.test(text)) throw new Error(`${owner}: remove interactive handlers`)
    if (/<script\b[^>]*\bsrc\s*=/i.test(text)) throw new Error(`${owner}: use an inline script for offline motion`)
  }
  const checkCss = (css: string, file: string): void => {
    checkResources(css, file)
    postcss.parse(css, { from: file })
    if (/@import\s/i.test(css)) throw new Error(`${file}: HTML stylesheets must inline CSS imports`)
  }
  const inline = (text: string, owner: string): string => mapReferences(manifestOf('html'), text, (src, found) => {
    let file: string
    try { file = contained(path.resolve(path.dirname(owner), src.replace(/[?#].*$/, '')), root) }
    catch (error) { throw new Error(`${owner}:${found.line ?? 1}: ${src}: ${error instanceof Error ? error.message : String(error)}`) }
    const ext = path.extname(file).toLowerCase()
    if (assets.has(file)) throw new Error(`${owner}:${found.line ?? 1}: cyclic asset ${src}`)
    assets.set(file, '')
    let bytes = fs.readFileSync(file)
    if (ext === '.css') { checkCss(bytes.toString(), file); bytes = Buffer.from(inline(bytes.toString(), file)) }
    assets.delete(file)
    return `data:${TYPES[ext] ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`
  }) as string
  // Check HTML source before dressing it, which may otherwise leave missing CSS links intact.
  if (/\.html$/i.test(entry)) {
    const original = fs.readFileSync(entry, 'utf8')
    checkResources(original, entry)
    inline(original, entry)
  }
  checkResources(html, entry)
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) checkCss(style[1]!, entry)
  html = inline(html, entry)
  const parser = 'parse5'
  const { parse } = await import(parser)
  const errors: {code: string; startLine: number; startCol: number}[] = []
  const syntaxHtml = /\.html$/i.test(entry) ? fs.readFileSync(entry, 'utf8') : html
  parse(syntaxHtml, { onParseError: (error: typeof errors[number]) => { if (error.code !== 'missing-doctype') errors.push(error) } })
  if (errors.length) throw new Error(errors.map(e => `${entry}:${e.startLine}:${e.startCol}: ${e.code}`).join('\n'))
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\btype\s*=\s*["'](?:application\/ld\+json|application\/json)["']/i.test(match[1]!)) continue
    const line = html.slice(0, match.index).split('\n').length
    checkStaticMockupCode(`${entry}:${line}`, match[2]!, true)
    try { new vm.Script(match[2]!, { filename: entry, lineOffset: line - 1 }) }
    catch (error) { throw new Error(`${entry}:${line}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return html
}

export async function checkMockups(entries: string[], work: string, signal?: AbortSignal): Promise<boolean> {
  const playwright = 'playwright'
  const { chromium } = await import(playwright)
  const browser = await chromium.launch({ headless: true })
  let passed = true
  const stop = () => { void browser.close() }
  signal?.addEventListener('abort', stop, {once: true})
  try {
    for (const name of entries) {
      if (signal?.aborted) return false
      const entry = path.resolve(name)
      let page
      try {
        const html = await pageFor(entry, work)
        page = await browser.newPage()
        const errors: string[] = []
        page.on('pageerror', (error: Error) => errors.push(error.stack || error.message || String(error)))
        page.on('console', (message: {type(): string; text(): string}) => { if (message.type() === 'error') errors.push(message.text()) })
        await page.route('**/*', (route: {abort(): Promise<void>}) => route.abort())
        for (const viewport of [{width: 1280, height: 800}, {width: 393, height: 852}]) {
          await page.goto('about:blank')
          await page.setViewportSize(viewport)
          await page.setContent(html, { waitUntil: 'load', timeout: 10000 })
          await page.evaluate('document.fonts.ready')
          await page.screenshot({ timeout: 10000 })
          const broken = await page.evaluate('Array.from(document.images).filter(image => !image.complete || !image.naturalWidth).map(image => image.alt || image.src.slice(0, 80))')
          if (broken.length) throw new Error(`images failed to render: ${broken.join(', ')}`)
        }
        if (errors.length) throw new Error([...new Set(errors)].join('\n'))
        console.log(`PASS ${entry}`)
      } catch (error) {
        passed = false
        console.error(`FAIL ${entry}\n${renderError(error)}`)
      } finally { await page?.close() }
    }
  } finally { signal?.removeEventListener('abort', stop); await browser.close() }
  return passed
}
