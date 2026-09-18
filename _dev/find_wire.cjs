/**
 * 查"DSH 到底怎么把用户消息包装成发给 API 的请求"：
 *   - 找 llm/deepseek 适配器文件
 *   - 在这些文件里搜 请求体构造关键词（chat/completions、messages、tools、reasoning_content）
 *   - 顺便把全 asar 里那几个特殊字符（U+FF5C / U+2581）落在哪个文件、上下文是什么打出来
 * 输出按文件聚合 + 少量上下文行（不打印特殊字符字面量，只打码点）。
 *
 *   node _dev/find_wire.cjs
 */
process.noAsar = true
const fs = require('fs')

const ASAR = 'E:/DSH Desktop/resources/app.asar'
const BAR = String.fromCharCode(0xff5c)
const SEP = String.fromCharCode(0x2581)
const codes = s => [...s].map(ch => { const cp = ch.codePointAt(0); return cp < 128 ? ch : 'U+' + cp.toString(16).toUpperCase() }).join('')

const buf = fs.readFileSync(ASAR)
const headerSize = buf.readUInt32LE(12)
let hstr = buf.subarray(16, 16 + headerSize).toString('utf8')
hstr = hstr.slice(0, hstr.lastIndexOf('}') + 1)
const header = JSON.parse(hstr)
const dataOffset = 8 + headerSize
const entries = []
;(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (val.files) walk(val, p)
    else if (val.offset !== undefined) entries.push({ path: p, offset: Number(val.offset), size: Number(val.size) })
  }
})(header, '')
entries.sort((a, b) => a.offset - b.offset)

function pathOf(abs) {
  let lo = 0, hi = entries.length - 1, best = '(header)'
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (dataOffset + entries[mid].offset <= abs) { best = entries[mid].path; lo = mid + 1 } else hi = mid - 1
  }
  return best
}

function textOf(path) {
  const e = entries.find(x => x.path === path)
  if (!e) return ''
  return buf.subarray(dataOffset + e.offset, dataOffset + e.offset + e.size).toString('utf8')
}

// 1) 哪些文件提到这些关键词
const KEYS = ['chat/completions', 'reasoning_content', 'tool_calls', 'Authorization', 'stream_options']
const fileHits = new Map()
for (const e of entries) {
  if (e.size > 3_000_000) continue
  let t = ''
  try { t = textOf(e.path) } catch { continue }
  const hit = KEYS.filter(k => t.includes(k))
  if (hit.length >= 2) fileHits.set(e.path, hit)
}
console.log('=== 同时提到两个以上关键词的文件（很可能是适配器/请求构造处）===')
for (const [p, hit] of [...fileHits.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
  console.log(`  ${p}   [${hit.join(', ')}]`)
}

// 2) 特殊字符落在哪
console.log('\n=== 特殊字符落点 ===')
for (const [name, ch] of [['U+FF5C', BAR], ['U+2581', SEP]]) {
  const nb = Buffer.from(ch, 'utf8')
  let at = 0
  const spots = []
  while ((at = buf.indexOf(nb, at)) >= 0) { spots.push(at); at += nb.length }
  console.log(`  ${name}: ${spots.length} 处`)
  for (const s of spots.slice(0, 6)) {
    const p = pathOf(s)
    const e = entries.find(x => x.path === p && dataOffset + x.offset <= s)
    let ctx = ''
    if (e) {
      const start = Math.max(0, s - (dataOffset + e.offset) - 120)
      ctx = buf.subarray(s - 120, s + 120).toString('utf8')
    }
    console.log(`     ${p}`)
    console.log('       ' + codes(ctx).replace(/\s+/g, ' ').slice(0, 190))
  }
}

// 3) 在候选适配器里把请求体构造那几行打出来
console.log('\n=== 候选文件里的请求体构造 ===')
for (const [p] of [...fileHits.entries()].slice(0, 4)) {
  const lines = textOf(p).split('\n')
  console.log('\n── ' + p + '  (' + lines.length + ' 行)')
  let shown = 0
  for (let i = 0; i < lines.length && shown < 6; i++) {
    const l = lines[i]
    if (/messages:|messages =|body\s*=|JSON\.stringify\(\{|role:|tool_calls|chat\/completions|reasoning_content/.test(l) && l.length < 400) {
      shown += 1
      console.log(`  ${i + 1}: ${codes(l.trim()).slice(0, 220)}`)
    }
  }
}
