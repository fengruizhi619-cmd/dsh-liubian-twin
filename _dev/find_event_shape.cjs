/**
 * 查宿主怎么校验 assistant/message 事件（插件要往会话里追加监察记录，形状必须对）。
 *   node _dev/find_event_shape.cjs [关键词]
 */
process.noAsar = true
const fs = require('fs')

const ASAR = 'E:/DSH Desktop/resources/app.asar'
const KEY = process.argv[2] || 'assistant/message'
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
    else if (val.offset !== undefined && val.size < 2_500_000) entries.push({ path: p, offset: Number(val.offset), size: Number(val.size) })
  }
})(header, '')
console.log('扫描文件数:', entries.length, '｜关键词:', KEY)
let printed = 0
const files = []
for (const e of entries) {
  const text = buf.subarray(dataOffset + e.offset, dataOffset + e.offset + e.size).toString('utf8')
  if (!text.includes(KEY)) continue
  files.push(e.path)
  if (printed > 26) continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && printed <= 26; i++) {
    const l = lines[i]
    if (!l.includes(KEY) && !/assertMessageEventShape|assert.*Message|surfaceOp|function assert/.test(l)) continue
    if (l.length > 260) continue
    printed += 1
    console.log(`${e.path.split('/').slice(-3).join('/')}:${i + 1}  ${l.trim().slice(0, 230)}`)
  }
}
console.log('\n提到该关键词的文件:', files.length)
for (const f of files.slice(0, 12)) console.log('  ' + f)
