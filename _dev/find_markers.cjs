/**
 * 找"阶段标记"到底存在于哪一层：
 *   A. app.asar 里有没有这些特殊字符（全角竖线 U+FF5C / 词间分隔符 U+2581 / begin_of_sentence 之类）
 *      —— 有，说明是宿主本地拼模板；没有，说明模板在上游（API）那边，请求里根本不存在这些标记。
 *   B. 会话日志的 stream 分块里有没有（那是上游真正吐回来的原始增量）。
 * 只打码点与文件名，不打标记字面量（避免污染输出）。
 *
 *   node _dev/find_markers.cjs
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')

const BAR = String.fromCharCode(0xff5c)      // 全角竖线
const SEP = String.fromCharCode(0x2581)      // ▁
const patterns = [
  ['U+FF5C 全角竖线', BAR],
  ['U+2581 ▁', SEP],
  ['begin_of_sentence', 'begin_of_sentence'],
  ['end_of_sentence', 'end_of_sentence'],
  ['reasoning_content', 'reasoning_content'],
  ['tool' + SEP + 'calls', 'tool' + SEP + 'calls'],
  ['thinking', 'thinking'],
]

function scanFile(file, label, maxHits = 3) {
  const buf = fs.readFileSync(file)
  console.log('\n===== ' + label + ' (' + (buf.length / 1048576).toFixed(1) + ' MB) =====')
  for (const [name, needle] of patterns) {
    const nb = Buffer.from(needle, 'utf8')
    let at = 0
    let n = 0
    const spots = []
    while ((at = buf.indexOf(nb, at)) >= 0 && n < 5000) { n += 1; if (spots.length < maxHits) spots.push(at); at += nb.length }
    console.log(`  ${name.padEnd(22)} 命中 ${n}`)
    if (n && label.startsWith('AP')) continue // asar 命中就只报数，别刷屏
    for (const s of spots) {
      const text = buf.subarray(Math.max(0, s - 60), s + 60).toString('utf8')
      const codes = [...text].map(ch => { const cp = ch.codePointAt(0); return cp < 128 ? ch : 'U+' + cp.toString(16).toUpperCase() }).join('')
      console.log('      @' + s + ' ' + codes.replace(/\s+/g, ' ').slice(0, 200))
    }
  }
}

scanFile('E:/DSH Desktop/resources/app.asar', 'APP.ASAR（宿主代码）')

// 会话日志：找最近动过的那条
const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
let newest = null
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    const st = fs.statSync(f)
    if (!newest || st.mtimeMs > newest.mtimeMs) newest = { f, s, mtimeMs: st.mtimeMs }
  }
}
console.log('\n最新会话:', newest.s)

// 会话日志是 zstd，借 checklist 的解码器
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')
const { text } = dec.decodeSessionFile(newest.f)
const recs = text.split('\n').filter(l => l.trim())

let withBar = 0
let withSep = 0
let chunkTypes = new Set()
const samples = []
for (const line of recs) {
  if (!line.includes('"chunk"')) continue
  if (line.includes(BAR)) { withBar += 1; if (samples.length < 2) samples.push(line) }
  if (line.includes(SEP)) withSep += 1
  for (const m of line.matchAll(/"type":"([a-z-]+)"/g)) chunkTypes.add(m[1])
}
console.log('含 stream 分块的行:', recs.filter(l => l.includes('"chunk"')).length)
console.log('其中含 U+FF5C 的行:', withBar, '｜含 U+2581 的行:', withSep)
console.log('日志里出现过的分块/事件类型抽样:', [...chunkTypes].slice(0, 24).join(', '))
if (samples.length) {
  console.log('\n样例（码点化，前 400 字符）：')
  for (const s of samples) {
    const codes = [...s.slice(0, 400)].map(ch => { const cp = ch.codePointAt(0); return cp < 128 ? ch : 'U+' + cp.toString(16).toUpperCase() }).join('')
    console.log('  ' + codes.replace(/\s+/g, ' '))
  }
}
