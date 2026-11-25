import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collect } from '../../artifact-sdk/src/internal/collect'
import { manifestOf, mapReferences } from '../../artifact-sdk/src/internal/manifest'
import { bodyReferences, captionsPath, overlayPath } from '../../artifact-sdk/src/internal/references'
import { mockupTags } from '../../artifact-sdk/src/internal/tags'
import { documentPreviewKey, OFFICE_TYPES, PDF } from '../../artifact-sdk/src/internal/document'
import { groupFrames } from '../../artifact-sdk/src/internal/format/spritesheet'
import { Previews, type Artifact, type ArtifactVersion, type Services } from '../../artifact-sdk/src/internal/previews'
import { connect, type Context } from '../../artifact-sdk/src/index'

const copy: Services['copy'] = { card: { mockup: { missing: x => `缺失:${x}`, undrawn: (x, why) => `画不出:${x}:${why}`, previewFailed: '读取失败' }, compare: { nested: '不能嵌套' }, save: { invalid: '无效', tooLarge: '过大', closed: '已关闭', refused: '无权限', offline: '离线', failed: '失败' } } }
const version = (n: number, content: unknown = null, type?: string): ArtifactVersion => ({ version: n, content, file: type ? { url: `file-${n}-${type}`, content_type: type } : null })
const art = (id: string, type: string, versions: ArtifactVersion[], name = id): Artifact => ({ id, name, type, latest_version: versions.at(-1)!.version, versions })

function preview(artifacts: Artifact[], assets: Record<string, { artifact: string; version?: number; error?: string }> = {}, options: Partial<Services> = {}, canSave = false) {
  return new Previews({ artifacts, card: { assets } }, { component: async () => ({ schema: { type: 'array' }, url: 'https://component.test' }), canSave, saved: () => {} }, {
    copy, locale: 'zh', readFile: async () => new Blob(['内容']), saveVersion: async () => ({ version: 3 }), errorCode: () => '', ...options,
  })
}

describe('SDK 资源声明与依赖图', () => {
  it('收集全部语言、对比、分镜和附件，跳过代码、注释及普通文字', () => {
    const body = [
      '<Asset src="a.png" variants=\'{"中文":"a.png","English":"b.png"}\' />',
      '<Mockup src="old.tsx" />', '<Compare a="a.mp4" b="b.json" shots="time.json" />', '<Storyboard src="slides.json" />',
      '[附件](notes.pdf)', '`<Asset src="code.png" />`', '<!--\n<Asset src="comment.png" />\n-->',
      '普通文字 <Asset src="text.png" />', '```tsx', '<Asset src="fence.png" />', '```', '    <Asset src="indent.png" />',
    ].join('\n')
    assert.deepEqual(bodyReferences(body).map(r => r.src), ['a.png', 'a.png', 'b.png', 'old.tsx', 'a.mp4', 'b.json', 'time.json', 'slides.json', 'notes.pdf'])
  })

  it('递归分镜与对比、规范路径去重，时间轴与普通 JSON 保持附件用途', () => {
    const files: Record<string, unknown> = {
      '/c/a.json': { a: 'v.mp4', b: 'b.json', shots: 'time.json' },
      '/c/b.json': { slides: [{ preview: { src: 'p.html' }, assets: ['x.png', './x.png'] }], shots: [{ frames: [{ src: 'x.png' }] }] },
      '/c/time.json': [{ id: 'S1', start: 0, end: 1, name: '一' }],
    }
    const graph = collect('<Compare a="a.json" b="v.mp4" />', '/c/card.md', {
      resolve: (src, owner) => { const key = new URL(src, `file://${owner}`).pathname; return { key, file: key } },
      read: key => key.endsWith('.json') ? JSON.stringify(files[key]) : '<main>页面</main>', retained: () => [],
    })
    assert.deepEqual(graph.map(n => n.key), ['/c/v.mp4', '/c/x.png', '/c/p.html', '/c/b.json', '/c/time.json', '/c/a.json'])
    assert.equal(graph.find(n => n.key === '/c/time.json')!.kind, 'asset')
    const b = graph.find(n => n.key === '/c/b.json')!
    assert.deepEqual(mapReferences(manifestOf(b.kind), b.data, () => 'art'), { slides: [{ preview: { src: 'art' }, assets: ['art', 'art'] }], shots: [{ frames: [{ src: 'art' }] }] })
  })

  it('收集跨行标签与附件，跳过跨行代码示例', () => {
    assert.deepEqual(bodyReferences('<Asset\n    src="zh.png"\n    variants=\'{"中文":"zh.png","English":"en.png"}\'\n/>\n`跨行\n<Asset src="code.png" />\n`\n[附件](notes.pdf)').map(r => r.src), ['zh.png', 'zh.png', 'en.png', 'notes.pdf'])
  })

  it('collects video overlays independently and follows relative HTML and CSS files', () => {
    const video = `<Asset src="film.mp4" variants='{"English":"film.mp4","中文":"film.mp4","Audio description":"film.mp4"}' overlay='{"English":"titles/en.html","中文":"titles/zh.htm"}' />`
    const shared = '<Asset src="loop.webm" overlay="titles/en.html" loop />'
    const [tag, loop] = mockupTags(`${video}\n${shared}`)
    assert.equal(overlayPath(tag!.overlay, 'English'), 'titles/en.html')
    assert.equal(overlayPath(tag!.overlay, '中文'), 'titles/zh.htm')
    assert.equal(overlayPath(tag!.overlay, 'Audio description'), undefined)
    assert.equal(overlayPath(loop!.overlay, 'English'), 'titles/en.html')
    assert.deepEqual(bodyReferences(`${video}\n${shared}`).map(ref => ref.src), [
      'film.mp4', 'film.mp4', 'film.mp4', 'film.mp4', 'titles/en.html', 'titles/zh.htm', 'loop.webm', 'titles/en.html',
    ])

    const files: Record<string, string> = {
      '/c/film.mp4': '',
      '/c/titles/en.html': '<link rel="stylesheet" href="style.css"><img src="../star.svg">',
      '/c/titles/style.css': '@font-face { src: url(../fonts/title.woff2); }',
      '/c/star.svg': '', '/c/fonts/title.woff2': '',
    }
    const graph = collect(video, '/c/card.md', {
      resolve: (src, owner) => {
        const key = new URL(src, `file://${owner}`).pathname
        if (!Object.hasOwn(files, key)) throw new Error('file not found')
        return { key, file: key }
      },
      read: file => files[file]!, retained: () => [],
    })
    assert.deepEqual(graph.map(node => [node.key, node.error]), [
      ['/c/film.mp4', undefined], ['/c/star.svg', undefined], ['/c/fonts/title.woff2', undefined],
      ['/c/titles/style.css', undefined], ['/c/titles/en.html', undefined], ['titles/zh.htm', 'file not found'],
    ])
  })

  it('collects a caption for each exact media variant and leaves invalid pairings unbound', () => {
    const asset = `<Asset src="a.mp4" variants='{"English":"a.mp4","中文":"b.mp4"}' captions='{"中文":"b.vtt","English":"a.srt"}' />`
    const [tag] = mockupTags(asset)
    assert.equal(captionsPath(tag!.captions, 'English'), 'a.srt')
    assert.equal(captionsPath(tag!.captions, '中文'), 'b.vtt')
    assert.equal(captionsPath(tag!.captions, 'toString'), undefined)
    assert.deepEqual(bodyReferences(asset).slice(3), [{ src: 'a.srt', types: ['asset'] }, { src: 'b.vtt', types: ['asset'] }])
    for (const captions of ['a.srt', '{"English":"a.srt"}', '{"English":"a.srt","中文":"https://example.test/b.vtt"}']) {
      const invalid = asset.replace(/captions='[^']*'/, `captions='${captions}'`)
      assert.equal(mockupTags(invalid)[0]!.captions, undefined)
      assert.equal(bodyReferences(invalid).length, 3)
    }
    const single = '<Asset src="podcast.mp3" captions="podcast.vtt" />'
    assert.equal(captionsPath(mockupTags(single)[0]!.captions, null), 'podcast.vtt')
    assert.equal(bodyReferences(single)[1]?.src, 'podcast.vtt')
  })

  it('reads and downloads the pinned subtitle bytes, handling invalid or unavailable cues independently', async () => {
    const srt = '\uFEFF1\r\n00:00:02,125 --> 00:00:04,000\r\n<b>First &amp; second</b>\r\nNext line\r\n'
    const vtt = 'WEBVTT\n\nNOTE comment\nignored\n\nintro\n00:05.500 --> 00:08.000 align:start\n<v Narrator>你好\n'
    const sub = art('sub', 'asset', [version(1, null, 'application/x-subrip'), version(2, null, 'text/vtt')])
    const missing = art('missing', 'asset', [version(3, null, 'text/vtt')])
    const service = preview([sub, missing], {
      'first.srt': { artifact: sub.id, version: 1 },
      'second.vtt': { artifact: sub.id, version: 2 },
      'missing.vtt': { artifact: missing.id, version: 3 },
    }, { readFile: async url => {
      if (url.startsWith('file-3-')) throw Error('offline')
      return new Blob([url.startsWith('file-1-') ? srt : vtt])
    } })
    const first = service.captionsOfSrc('first.srt')
    assert.deepEqual(await first.load!(), [{ start: 2.125, end: 4, text: 'First & second\nNext line' }])
    assert.equal(first.download?.name, 'first.srt')
    const original = await first.download!.load()
    assert.deepEqual(new Uint8Array(await (await fetch(original)).arrayBuffer()), new TextEncoder().encode(srt))
    assert.deepEqual(await service.captionsOfSrc('second.vtt').load!(), [{ start: 5.5, end: 8, text: '你好' }])
    assert.deepEqual(await service.captionsOfSrc('missing.vtt').load!(), [])
  })

  it('循环仍抛错；缺失文件、无效 JSON 和不符合声明的分镜记在节点上（#457、#458）', () => {
    const host = { resolve: (src: string) => ({ key: src, file: src }), retained: () => [], read: () => JSON.stringify({ a: 'loop.json', b: 'v.mp4' }) }
    assert.throws(() => collect('<Compare a="loop.json" b="v.mp4" />', 'card.md', host), /loop.json.*资源依赖循环/)
    const bad = collect('<Storyboard src="bad.json" />', 'card.md', { ...host, read: () => '{' })
    assert.equal(bad.find(n => n.key === 'bad.json')!.error, 'not valid JSON: bad.json')
    assert.match(collect('<Storyboard src="bad.json" />', 'card.md', { ...host, read: () => '{"slides":"x"}' }).at(-1)!.error!, /does not match storyboard at \/slides/)
    const missing = collect('<Storyboard src="deck.json" />\n\n<Asset src="gone.png" />', 'card.md', {
      ...host, read: () => JSON.stringify({ slides: [{ preview: { src: 'gone.html' } }] }),
      resolve: src => { if (src.startsWith('gone')) throw new Error(`file not found: ${src}`); return { key: src, file: src } },
    })
    assert.deepEqual(missing.map(n => [n.key, n.error]), [['deck.json', 'file not found: gone.html'], ['gone.png', 'file not found: gone.png']])
  })

  it('页面引用的图片、样式和字体按 html 清单收集，缺失的文件记在页面的那一行（#458）', () => {
    const page = '<html><head><style>@font-face{src:url("../fonts/a.otf")}</style></head>\n<body><img src="logo.svg?v=1">\n<img srcset="a.png 1x, b.png 2x" src="https://x.test/c.png">\n<img src="gone.png"><a href="other.html">x</a></body></html>'
    const graph = collect('<Asset src="pages/p.html" />', '/c/card.md', {
      resolve: (src, owner) => { const key = new URL(src, `file://${owner}`).pathname; if (key.includes('gone')) throw new Error('no such file'); return { key, file: key } },
      read: () => page, retained: () => [],
    })
    const p = graph.at(-1)!
    assert.deepEqual([...p.dependencies.keys()], ['logo.svg?v=1', 'a.png', 'b.png', '../fonts/a.otf'])
    assert.deepEqual(p.problems, [{ src: 'gone.png', line: 4, message: 'no such file' }])
    assert.equal(p.error, 'no such file')
    assert.match(mapReferences(manifestOf('html'), page, s => s === 'a.png' ? 'art_a' : s) as string, /srcset="art_a 1x, b.png 2x"/)
  })

  it('脚本里的文字不算引用，标签和样式里缺失的文件照旧报错（#560）', () => {
    const page = '<script src="app.js"></script><script>const f = e => `url(${e})`; el.innerHTML = \'<img src="x.png">\'</script>\n<img src="gone.png"><style>b{background:url(gone-bg.png)}</style><link rel="stylesheet" href="s.css">'
    const graph = collect('<Asset src="p.html" />', '/c/card.md', {
      resolve: (src, owner) => { const key = new URL(src, `file://${owner}`).pathname; if (key.includes('gone')) throw new Error('no such file'); return { key, file: key } },
      read: () => page, retained: () => [],
    })
    const p = graph.find(n => n.key === '/c/p.html')!
    assert.deepEqual([...p.dependencies.keys()], ['app.js', 's.css'])
    assert.deepEqual(p.problems.map(x => x.src), ['gone.png', 'gone-bg.png'])
  })

  it('collects external stylesheets and their relative imports and images', () => {
    const files: Record<string, string> = {
      '/c/page.html': '<link rel="stylesheet" href="styles/main.css">',
      '/c/styles/main.css': '@import "theme/skin.css"; /* url(missing.png) */',
      '/c/styles/theme/skin.css': 'main { background: url(../../images/cover.svg#detail) }',
      '/c/images/cover.svg': '<svg />',
    }
    const graph = collect('<Asset src="page.html" />', '/c/card.md', {
      resolve: (src, owner) => {
        const key = new URL(src, `file://${owner}`).pathname
        if (!(key in files)) throw new Error(`file not found: ${key}`)
        return { key, file: key }
      },
      read: file => files[file]!,
      retained: () => [],
    })
    assert.deepEqual(graph.map(node => node.key), Object.keys(files).reverse())
    assert.deepEqual(graph.map(node => [...node.dependencies.keys()]), [
      [], ['../../images/cover.svg#detail'], ['theme/skin.css'], ['styles/main.css'],
    ])
    assert.ok(graph.every(node => !node.error))
  })

  it('本机缺少已有云端分镜时，仍保留依赖的用途和嵌套资源', () => {
    const graph = collect('<Storyboard src="remote.json" />', 'card.md', {
      resolve: src => ({ key: src, file: src === 'remote.json' ? null : src }),
      retained: key => key === 'remote.json' ? [{ src: 'nested.json', types: ['storyboard'] }] : [],
      read: () => JSON.stringify({ shots: [{ frames: [{ src: 'image.png' }] }] }),
    })
    assert.deepEqual(graph.map(n => n.key), ['image.png', 'nested.json', 'remote.json'])
    assert.equal(graph[1]!.kind, 'storyboard')
  })

  it('Tiled 地图的外置 .tsx 图块集按 tiled 收集，并带上它的图片（#480）', () => {
    const files: Record<string, string> = {
      '/c/level.tmx': '<map><tileset firstgid="1" source="tiles/forest.tsx"/><imagelayer><image source="sky.png"/></imagelayer></map>',
      '/c/tiles/forest.tsx': '<tileset name="forest"><image source="forest.png" width="64" height="64"/></tileset>',
    }
    const graph = collect('<Asset src="level.tmx" />', '/c/card.md', {
      resolve: (src, owner) => { const key = new URL(src, `file://${owner}`).pathname; return { key, file: key } },
      read: key => files[key] ?? '', retained: () => [],
    })
    assert.deepEqual(graph.map(n => [n.key, n.kind]), [['/c/tiles/forest.png', 'image'], ['/c/tiles/forest.tsx', 'tiled'], ['/c/sky.png', 'image'], ['/c/level.tmx', 'tiled']])
  })
  it('TexturePacker 帧数据按 spritesheet 收集并带上图片，Aseprite 导出仍是附件（#481）', () => {
    const files: Record<string, string> = {
      '/c/hero.json': JSON.stringify({ frames: { 'run_01.png': { frame: { x: 0, y: 0, w: 8, h: 8 } } }, meta: { app: 'https://www.codeandweb.com/texturepacker', image: 'hero.png' } }),
      '/c/ase.json': JSON.stringify({ frames: [{ filename: 'a 0', frame: { x: 0, y: 0, w: 8, h: 8 }, duration: 100 }], meta: { app: 'https://www.aseprite.org/', image: 'ase.png' } }),
    }
    const graph = collect('<Asset src="hero.json" />\n\n<Asset src="ase.json" />\n\n<Asset src="pic.png" />', '/c/card.md', {
      resolve: (src, owner) => { const key = new URL(src, `file://${owner}`).pathname; return { key, file: key } },
      read: key => files[key] ?? '', retained: () => [],
    })
    assert.deepEqual(graph.map(n => [n.key, n.kind]), [['/c/hero.png', 'image'], ['/c/hero.json', 'spritesheet'], ['/c/ase.json', 'asset'], ['/c/pic.png', 'image']])
  })

  it('精灵帧名去掉扩展名与末尾序号分组，组内按序号排序（#481）', () => {
    const names = ['idle-2', 'run_02.png', 'run_01.png', ...[3, 4, 5, 6, 7, 8].map(n => `run_0${n}.png`), 'idle-1', 'idle-3', 'idle-4']
    assert.deepEqual(groupFrames(names).map(a => [a.name, a.frames.map(i => names[i])]), [
      ['idle', ['idle-1', 'idle-2', 'idle-3', 'idle-4']],
      ['run', ['run_01.png', 'run_02.png', ...[3, 4, 5, 6, 7, 8].map(n => `run_0${n}.png`)]],
    ])
  })
})

describe('SDK 内置预览运行时', () => {
  it('uses the original filename and pinned bytes for model assets (#1077)', async () => {
    for (const format of ['glb', 'blend'] as const) {
      const name = `model.${format}`
      const src = `.assets/1081/${name}`
      const pinned = version(1, null, 'application/octet-stream')
      const files = [art('model', 'asset', [pinned, version(2, null, 'application/octet-stream')], `assets_1081_${name}`)]
      const p = preview(files, { [src]: { artifact: 'model', version: 1 } }, {
        readFile: async url => {
          assert.equal(url, pinned.file!.url)
          return new Blob(['original bytes'])
        },
      })
      const view = p.viewOfSrc(src)
      assert.ok(view.model)
      assert.equal(view.model.format, format)
      assert.equal(view.model.file.name, name)
      assert.equal(view.download, view.model.file)
      const href = await view.model.file.load()
      try {
        assert.equal(await (await fetch(href)).text(), 'original bytes')
      } finally {
        URL.revokeObjectURL(href)
      }
    }
  })

  it('各内置类型通过 SDK 读取当前内容与文件，错误可见', async () => {
    const artifacts = [art('html', 'html', [version(1, { html: '<main>页面</main>' })]), art('hf.hf.html', 'html', [version(1, '<div>动画</div>')]), art('image', 'image', [version(1, null, 'image/png')]), art('video', 'video', [version(1, null, 'video/mp4')]), art('audio', 'video', [version(1, null, 'audio/mpeg')]), art('md', 'markdown', [version(1, { markdown: '# 内容' })]), art('file', 'asset', [version(1, { value: 1 })])]
    const p = preview(artifacts)
    assert.equal((await p.viewOfArtifact('html').deferred!.load()).doc, '<main>页面</main>')
    assert.equal((await p.viewOfArtifact('hf.hf.html').deferred!.load()).hyperframe, true)
    assert.match((await p.viewOfArtifact('image').deferred!.load()).image!, /^blob:/)
    assert.equal((await p.viewOfArtifact('video').deferred!.load()).media!.kind, 'video')
    assert.equal((await p.viewOfArtifact('audio').deferred!.load()).media!.kind, 'audio')
    assert.equal((await p.viewOfArtifact('md').deferred!.load()).article!.text, '# 内容')
    assert.match(await p.viewOfArtifact('file').file!.load(), /^blob:/)
    assert.equal((await preview(artifacts, {}, { readFile: async () => { throw new Error('offline') } }).viewOfArtifact('image').deferred!.load()).error, '读取失败')
  })

  it('routes delimited tables, converted documents, models and download-only files in order', async () => {
    const csv = 'Item,Total\nA,5'
    const tsv = 'Item\tTotal\nB\t8'
    const files = [
      art('csv', 'asset', [version(1, null, 'text/csv')], 'revenue.CSV'),
      art('tsv', 'asset', [version(1, null, 'application/octet-stream')], 'old-file'),
      art('doc', 'asset', [version(1, null, OFFICE_TYPES['.docx'])], 'report.docx'),
      art('pdf', 'asset', [version(1, null, PDF)], 'report.pdf'),
      art('blend', 'asset', [version(1, null, 'application/octet-stream')], 'model.BLEND'),
      art('zip', 'asset', [version(1, null, 'application/zip')], 'source.zip'),
    ]
    const pins = { 'costs.tsv': { artifact: 'tsv', version: 1 }, 'report.csv': { artifact: 'doc', version: 1 } }
    const p = preview(files, { ...pins, [documentPreviewKey('doc', 1)]: { artifact: 'pdf', version: 1 } }, {
      readFile: async url => new Blob([url.endsWith('text/csv') ? csv : url.endsWith('octet-stream') ? Buffer.from('\uFEFF' + tsv, 'utf16le') : '%PDF-']),
    })
    const csvView = p.viewOfArtifact('csv')
    assert.equal(csvView.delimited?.delimiter, ',')
    assert.deepEqual(await csvView.delimited?.load(), { text: csv })
    const tsvView = p.viewOfSrc('costs.tsv')
    assert.equal(tsvView.delimited?.delimiter, '\t')
    assert.deepEqual(await tsvView.delimited?.load(), { text: tsv })

    const docView = p.viewOfSrc('report.csv')
    assert.equal(await (await docView.document?.load?.())?.text(), '%PDF-')
    assert.equal(docView.download?.name, 'report.docx')
    assert.equal(preview(files, pins).viewOfSrc('report.csv').document?.load, null)
    assert.equal(p.viewOfArtifact('blend').model?.format, 'blend')
    const zip = p.viewOfArtifact('zip')
    assert.equal(zip.file?.name, 'source.zip')
    assert.equal(zip.deferred, undefined)
  })

  it('分镜、HTML 幻灯片、两侧与 shots 遵守清单固定版本，包括文件 JSON 和旧路径', async () => {
    const files: string[] = []
    const artifacts = [
      art('img', 'image', [version(1, null, 'image/png'), version(2, null, 'image/png')]),
      art('page', 'html', [version(1, '<main>旧页面</main>'), version(2, '新页面')]),
      art('board', 'storyboard', [version(1, null, 'application/json')], '.assets/1/board.json'),
      art('clip', 'video', [version(1, null, 'video/mp4')]),
      art('compare', 'compare', [version(1, { a: 'clip', b: 'board', shots: 'board' })]),
    ]
    const assets = { '.assets/1/image.png': { artifact: 'img', version: 1 }, '.assets/1/page.html': { artifact: 'page', version: 1 }, '.assets/1/board.json': { artifact: 'board', version: 1 } }
    const p = preview(artifacts, assets, { readFile: async url => {
      files.push(url)
      return new Blob([url.includes('json') ? JSON.stringify({ slides: [{ id: 's1', title: '标题', copy: [], layout: 'full', assets: ['img'], preview: { src: 'page.html', alt: '' } }], shots: [{ id: 'S1', start: 0, end: 1, voiceover: { mode: 'none' }, action: '', captions: [], frames: [{ src: 'img', alt: '' }] }] }) : '图像'])
    } })
    const result = await p.viewOfArtifact('compare').compare!.load()
    assert.ok(!('sides' in result) && result.a.media)
    assert.ok('storyboard' in result.b)
    assert.ok(result.breakdown!.shots![0]!.frames[0]!.href)
    const slides = preview([art('slides', 'storyboard', [version(1, { slides: [{ preview: { src: 'page', alt: '' } }] })]), ...artifacts], assets)
    assert.equal((await slides.viewOfArtifact('slides').storyboard!()).slides![0]!.preview.doc, '<main>旧页面</main>')
    assert.ok(files.every(url => !url.startsWith('file-2')))
  })

  it('文档里的图片换成可显示的地址，缺失的图记在文档那一行（#497）', async () => {
    const text = '# 试跑\n\n![待机](gif)\n<img src="gone.png">\n![远程](https://x.test/y.png)'
    const p = preview([art('notes', 'markdown', [version(1, text)]), art('gif', 'image', [version(1, null, 'image/gif')])])
    const shown = (await p.viewOfArtifact('notes').deferred!.load()).article!.text
    assert.match(shown, /!\[待机\]\(blob:[^)]+\)\n<img src="gone.png">\n!\[远程\]\(https:\/\/x.test\/y.png\)/)
    const graph = collect('<Asset src="trial/notes.md" />', '/c/card.md', {
      resolve: (src, owner) => { const key = new URL(src, `file://${owner}`).pathname; if (key.includes('gone')) throw new Error('no such file'); return { key, file: key } },
      read: () => text.replace('(gif)', '(moves/idle.gif)'), retained: () => [],
    })
    assert.deepEqual(graph.map(n => n.key), ['/c/trial/moves/idle.gif', '/c/trial/notes.md'])
    assert.deepEqual(graph.at(-1)!.problems, [{ src: 'gone.png', line: 4, message: 'no such file' }])
  })

  it('第三方组件继续提供 SDK Context，审核只读，保存验证权限与 schema', async () => {
    const v = { ...version(1, []), component: { name: '@x/subtitles', version: '1' } }
    const artifacts = [art('custom', '@x/subtitles', [v])]
    const readOnly = preview(artifacts).viewOfArtifact('custom').component!
    assert.equal((await readOnly.load()).context.readOnly, true)
    assert.equal(readOnly.save, null)
    const editable = preview(artifacts, {}, {}, true).viewOfArtifact('custom').component!
    assert.equal((await editable.load()).context.locale, 'zh')
    await assert.rejects(editable.save!({}), /无效/)
    assert.deepEqual(await editable.save!([]), { version: 3 })
  })

  it('第三方组件按清单 references 拿到内容引用的文件（#458）', async () => {
    const v = { ...version(1, { video: 'clip', cues: [] }), component: { name: 'subtitles', version: '1' } }
    const artifacts = [art('custom', '@x/subtitles', [v]), art('clip', 'video', [version(1, null, 'video/mp4')])]
    const p = new Previews({ artifacts, card: { assets: {} } }, { component: async () => ({ schema: null, url: 'https://component.test', references: [{ json: '/video' }] }), canSave: false, saved: () => {} }, {
      copy, locale: 'zh', readFile: async () => new Blob(['视频']), saveVersion: async () => ({ version: 2 }), errorCode: () => '',
    })
    const { context } = await p.viewOfArtifact('custom').component!.load()
    assert.equal(context.files!.clip!.contentType, 'video/mp4')
    assert.equal(new TextDecoder().decode(context.files!.clip!.data), '视频')
  })

  it('对比两侧和分镜画面可以是任何素材，嵌套的对比和分镜被拒（#526）', async () => {
    const shot = { id: 'S1', start: 0, end: 1, voiceover: { mode: 'none' }, action: '', captions: [], frames: [{ src: 'clip', alt: '' }, { src: 'cmp', alt: '' }, { src: 'page', alt: '' }] }
    const p = preview([
      art('img', 'image', [version(1, null, 'image/png')]),
      art('page', 'html', [version(1, '<main>页面</main>')]),
      art('clip', 'video', [version(1, null, 'video/mp4')]),
      art('cmp', 'compare', [version(1, { a: 'img', b: 'page' })]),
      art('board', 'storyboard', [version(1, { shots: [shot] })]),
      art('outer', 'compare', [version(1, { a: 'cmp', b: 'board' })]),
    ])
    const mixed = await p.viewOfArtifact('cmp').compare!.load()
    assert.ok('sides' in mixed && mixed.sides[0].deferred && mixed.sides[1].deferred!.screen)
    const outer = await p.viewOfArtifact('outer').compare!.load()
    assert.ok('sides' in outer && outer.sides[0].error === '不能嵌套' && outer.sides[1].storyboard)
    const frames = (await p.viewOfArtifact('board').storyboard!()).shots![0]!.frames
    assert.deepEqual(frames.map(f => [!!f.view?.deferred, f.view?.error, !!f.view?.download]), [[true, undefined, true], [false, '不能嵌套', false], [true, undefined, true]])
  })

  it('同一 artifact 的两个路径各自使用固定版本', async () => {
    const reads: string[] = []
    const p = preview([art('img', 'image', [version(1, null, 'image/png'), version(2, null, 'image/png')])], { 'old.png': { artifact: 'img', version: 1 }, 'new.png': { artifact: 'img', version: 2 } }, { readFile: async url => { reads.push(url); return new Blob(['图像']) } })
    await p.compareOfTag({ a: 'old.png', b: 'new.png', shots: '', label: '', aLabel: '', bLabel: '' }).load()
    assert.deepEqual(reads.sort(), ['file-1-image/png', 'file-2-image/png'])
  })
})

it('第三方 connect() 保持初始化、权限变化和保存消息契约', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const context: Context = { artifact: { type: '@x/subtitles', name: '字幕', version: 1, content: [] }, readOnly: true, locale: 'zh', theme: 'light' }
  let receive!: (event: { source: unknown; origin: string; data: unknown }) => void
  const parent = { postMessage: (data: { id: number; method: string }, origin: string) => {
    assert.ok(origin === '*' || origin === 'https://review.test')
    queueMicrotask(() => receive({ source: parent, origin: 'https://review.test', data: { jsonrpc: '2.0', id: data.id, result: data.method === 'ui/initialize' ? context : { version: 2 } } }))
  } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { parent, addEventListener: (_: string, listener: typeof receive) => { receive = listener } } })
  try {
    const bridge = await connect({ autoResize: false, timeout: 100 })
    assert.equal(bridge.artifact.version, 1)
    await assert.rejects(bridge.save([]), /没有保存权限/)
    let changes = 0
    const unsubscribe = bridge.onChange(() => changes++)
    receive({ source: parent, origin: 'https://review.test', data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { readOnly: false } } })
    assert.equal(changes, 1)
    assert.equal(bridge.readOnly, false)
    assert.deepEqual(await bridge.save([]), { version: 2 })
    unsubscribe()
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

describe('存成普通文件的工作台图（#484）', () => {
  it('Studio 标签照样画出，其他标签仍是普通文件', async () => {
    const flow = { version: 1, rounds: [], land: [], scheduled: [] }
    const p = preview([art('a1', 'asset', [version(1, null, 'application/json')])], { '.assets/2/studio.json': { artifact: 'a1', version: 1 } }, { readFile: async () => new Blob([JSON.stringify(flow)]) })
    assert.deepEqual(await p.viewOfSrc('.assets/2/studio.json', '图', 'studio').studio!(), flow)
    assert.equal(p.viewOfSrc('.assets/2/studio.json').studio, undefined)
  })
})

describe('画不出的预览（#456）', () => {
  it('清单记着原因时，显示原因而不是旧版本或缺失', () => {
    const p = preview([art('a1', 'html', [version(1, { html: '<main>旧</main>' })])], { 'x.tsx': { artifact: 'a1', version: 1, error: 'ENOENT x.css' }, '.assets/1/y.tsx': { artifact: 'a2', error: 'boom' } })
    assert.equal(p.viewOfSrc('x.tsx', '首页').error, '画不出:首页:ENOENT x.css')
    assert.equal(p.viewOfSrc('.assets/1/y.tsx').error, '画不出:y.tsx:boom')
  })
})

it('Studio reviews declare frozen files and every result dependency, preserve partial failures and enforce current-task pins', async () => {
  const review = { version: 2, base: null, fingerprint: 'draft', agents: [{ agent: 'writer', title: { en: 'Writer' } }], files: [{ path: 'agents/writer/AGENT.md', before: null, after: 'after.txt', diff: 'change.diff' }], results: [{ agent: 'writer', component: 'Compare', a: 'cycle.json', b: 'page.html' }] }
  const files: Record<string, string> = { 'review.json': JSON.stringify(review), 'after.txt': 'Write.', 'change.diff': '+Write.', 'cycle.json': '{"a":"cycle.json","b":"page.html"}', 'page.html': '<p>Existing result</p>' }
  const graph = collect('<Studio src="review.json" />', 'card.md', { resolve: src => { if (!(src in files)) throw Error(`Missing: ${src}`); return { key: src, file: src } }, read: file => files[file]!, retained: () => [] })
  assert.equal(graph.at(-1)?.error, undefined)
  assert.match(graph.find(n => n.key === 'cycle.json')!.error!, /循环/)
  const p = preview([
    art('root', 'studio', [version(1, review)]),
    art('after', 'asset', [version(1, 'Pinned text'), version(2, 'Newer unreviewed text')]),
    art('unrelated', 'asset', [version(1, 'Must not read')]),
  ], { 'review.json': { artifact: 'root', version: 1 }, 'after.txt': { artifact: 'after', version: 1 }, 'failed.txt': { artifact: 'after', version: 1, error: 'Upload failed' } })
  const v = p.viewOfSrc('review.json')
  assert.equal((await v.studio!() as { version: number }).version, 2)
  assert.equal(await v.studioFiles!.text('after.txt'), 'Pinned text')
  await assert.rejects(() => v.studioFiles!.text('unrelated'), /缺失/)
  await assert.rejects(() => v.studioFiles!.text('failed.txt'), /Upload failed/)
  assert.match(v.studioFiles!.view('review.json').error!, /Cyclic/)
})
