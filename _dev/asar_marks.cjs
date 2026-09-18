/**
 * 一次性诊断脚本（_dev 专用）：在 app.asar 里找工具调用标记的**真实字符构成**。
 * 只打印命中点周围的码点（十六进制），不打印标记原文字面量 —— 那串字符写进
 * 聊天文本会污染模型流。搜 'DSML' 这个纯 ASCII 词，再回看两侧是什么字符。
 *
 * 用法: node asar_marks.cjs [最多打印几个命中] [侧向多少字符]
 */
process.noAsar = true
const fs = require('fs')

const ASAR = 'E:/DSH Desktop/resources/app.asar'
const maxHits = Number(process.argv[2] || 8)
const side = Number(process.argv[3] || 14)

const buf = fs.readFileSync(ASAR)
function readHeader(b) {
  const headerSize = b.readUInt32LE(12)
  let str = b.subarray(16, 16 + headerSize).toString('utf8')
  str = str.slice(0, str.lastIndexOf('}') + 1)
  return { header: JSON.parse(str), dataOffset: 8 + headerSize }
}
const { header, dataOffset } = readHeader(buf)
function walk(node, prefix, out) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (val.files) walk(val, p, out)
    else if (val.offset !== undefined) out.push({ path: p, offset: Number(val.offset), size: Number(val.size) })
  }
  return out
}
const entries = walk(header, '', []).sort((a, b) => a.offset - b.offset)
function pathOf(abs) {
  let lo = 0
  let hi = entries.length - 1
  let best = '(header)'
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const start = dataOffset + entries[mid].offset
    if (start <= abs) { best = entries[mid].path; lo = mid + 1 } else hi = mid - 1
  }
  return best
}

const needle = Buffer.from('DSML', 'utf8')
const hits = []
let from = 0
while (hits.length < 2000) {
  const at = buf.indexOf(needle, from)
  if (at < 0) break
  hits.push(at)
  from = at + 4
}
console.log('文件条目:', entries.length, '| "DSML" 出现次数:', hits.length)

const byFile = new Map()
for (const at of hits) {
  const p = pathOf(at)
  byFile.set(p, (byFile.get(p) || 0) + 1)
}
console.log('\n=== 按文件聚合 ===')
for (const [p, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${p}`)

console.log('\n=== 命中点两侧的码点（十六进制）===')
for (const at of hits.slice(0, maxHits)) {
  const s = buf.subarray(Math.max(0, at - side), Math.min(buf.length, at + 4 + side)).toString('utf8')
  const codes = [...s].map(ch => {
    const cp = ch.codePointAt(0)
    return cp < 128 ? ch : 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')
  })
  console.log(`\n@${at} [${pathOf(at)}]`)
  console.log('  ' + codes.join(' '))
}
