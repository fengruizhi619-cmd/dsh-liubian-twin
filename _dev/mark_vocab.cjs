/**
 * 把"上游漏出来的标记"词表扫出来：遍历最近若干个会话日志，
 * 找 stream 分块里含全角竖线(U+FF5C)或 ▁(U+2581) 的行，按标记形状归类计数。
 * 只打码点化的形状，不打原文。
 *
 *   node _dev/mark_vocab.cjs [最多扫几条会话]
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const BAR = String.fromCharCode(0xff5c)
const SEP = String.fromCharCode(0x2581)
const SHAPE = new RegExp('(' + BAR + '{2}[A-Za-z]*' + BAR + '{2}\\s?[A-Za-z_]*)', 'g')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const files = []
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) files.push({ f, s, mtimeMs: fs.statSync(f).mtimeMs })
  }
}
files.sort((a, b) => b.mtimeMs - a.mtimeMs)
const limit = Number(process.argv[2] || 6)

const vocab = new Map()
const sepSamples = []
let scanned = 0
for (const { f, s } of files.slice(0, limit)) {
  let text = ''
  try { text = dec.decodeSessionFile(f).text } catch { continue }
  scanned += 1
  for (const line of text.split('\n')) {
    if (!line.includes('"chunk"')) continue
    if (line.includes(BAR)) {
      for (const m of line.matchAll(SHAPE)) {
        const shape = [...m[1]].map(ch => { const cp = ch.codePointAt(0); return cp < 128 ? ch : 'U+' + cp.toString(16).toUpperCase() }).join('')
        vocab.set(shape, (vocab.get(shape) || 0) + 1)
      }
    }
    if (line.includes(SEP) && sepSamples.length < 4) {
      const i = line.indexOf(SEP)
      sepSamples.push([...line.slice(Math.max(0, i - 120), i + 120)].map(ch => { const cp = ch.codePointAt(0); return cp < 128 ? ch : 'U+' + cp.toString(16).toUpperCase() }).join('').replace(/\s+/g, ' '))
    }
  }
}
console.log('扫描会话数:', scanned, '（最近', limit, '条）')
console.log('\n=== 标记形状词表（全角竖线夹出来的）===')
for (const [k, n] of [...vocab.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`)
console.log('\n=== 含 ▁(U+2581) 的分块样例（码点化）===')
for (const s of sepSamples) console.log('  ' + s)
if (!vocab.size) console.log('（最近这些会话里没有出现全角竖线标记）')
