import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { SaxesParser } from 'saxes'
import type { OfficeExtension } from '../../artifact-sdk/src/internal/document'
import { ASSET_FILE_LIMIT } from '../../cli/src/lib/shared/file-limits'

const formats = {
  '.docx': { part: 'word/document.xml', input: 'Office Open XML Text', output: 'writer_pdf_Export' },
  '.pptx': { part: 'ppt/presentation.xml', input: 'Impress MS PowerPoint 2007 XML', output: 'impress_pdf_Export' },
}

const security = '/org.openoffice.Office.Common/Security/Scripting'
const profile = `<?xml version="1.0"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="${security}">
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Writer/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>0</value></prop>
    <prop oor:name="Field" oor:op="fuse"><value>false</value></prop>
    <prop oor:name="Chart" oor:op="fuse"><value>false</value></prop>
  </item>
</oor:items>`

function installedOffice(): string {
  const programs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
  const candidates = process.platform === 'darwin' ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
    : process.platform === 'win32' ? programs.flatMap(dir => dir ? [path.join(dir, 'LibreOffice', 'program', 'soffice.com')] : [])
      : []
  const executable = process.platform === 'win32' ? 'soffice.com' : 'soffice'
  const onPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, executable))
  return [...onPath, ...candidates].find(file => existsSync(file)) ?? executable
}

function checkPackage(bytes: Uint8Array, mainPart: string) {
  let hasMainPart = false
  let expanded = 0
  let relationshipSize = 0
  const relationships = unzipSync(bytes, { filter: entry => {
    hasMainPart ||= entry.name === mainPart && entry.originalSize > 0
    expanded += entry.originalSize
    if (expanded > 5 * ASSET_FILE_LIMIT) throw Error('Office package exceeds the preview size limit')
    if (!/\.rels$/i.test(entry.name)) return false
    relationshipSize += entry.originalSize
    if (relationshipSize > 4 * 1024 * 1024) throw Error('Office relationships exceed the preview size limit')
    return true
  } })
  if (!hasMainPart || !relationships['_rels/.rels']) throw Error('Invalid Office package')
  for (const part of Object.values(relationships)) {
    const xml = new SaxesParser({ xmlns: true })
    xml.on('doctype', () => { throw Error('Invalid Office relationships') })
    xml.on('opentag', ({ local, attributes }) => {
      if (local !== 'Relationship') return
      const target = attributes.Target?.value ?? ''
      const external = (attributes.TargetMode?.value ?? '').toLowerCase() === 'external'
        || /^(?:[a-z][\w+.-]*:|\/\/|\\)/i.test(target.trim())
      if (external && !attributes.Type?.value.endsWith('/hyperlink')) throw Error('Office package links to external content')
    })
    xml.write(strFromU8(part)).close()
  }
}

function convert(command: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const group = process.platform !== 'win32'
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: group })
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try { process.kill(group ? -child.pid : child.pid, 'SIGKILL') } catch { /* Process already exited. */ }
      }
      reject(Error('Office preview conversion timed out'))
    }, timeout)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    // Some LibreOffice versions return zero for invalid inputs. The freshly created PDF decides.
    child.once('close', () => { clearTimeout(timer); resolve() })
  })
}

export async function renderOfficePdf(bytes: Uint8Array, ext: OfficeExtension, command = installedOffice(), timeout = 30_000): Promise<Uint8Array> {
  const format = formats[ext]
  checkPackage(bytes, format.part)
  const dir = await mkdtemp(path.join(tmpdir(), 'wildcrane-document-'))
  try {
    const user = path.join(dir, 'profile', 'user')
    const input = path.join(dir, `source${ext}`)
    await mkdir(user, { recursive: true })
    await Promise.all([writeFile(input, bytes), writeFile(path.join(user, 'registrymodifications.xcu'), profile)])
    await convert(command, [
      `-env:UserInstallation=${pathToFileURL(path.dirname(user)).href}`, '--headless', '--norestore',
      `--infilter=${format.input}`, '--convert-to', `pdf:${format.output}`, '--outdir', dir, input,
    ], timeout)
    const output = path.join(dir, 'source.pdf')
    const { size } = await stat(output)
    if (!size || size > ASSET_FILE_LIMIT) throw Error('Invalid Office preview size')
    const pdf = await readFile(output)
    const document = await PDFDocument.load(pdf, { throwOnInvalidObject: true, updateMetadata: false })
    if (!document.getPageCount()) throw Error('Office preview has no pages')
    return pdf
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
