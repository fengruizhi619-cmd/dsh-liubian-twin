/**
 * 从 app.asar 里按路径打印某个文件（或只用正则筛行）。
 *   node _dev/asar_lines.cjs <asar 内路径> [正则] [最多行数]
 */
process.noAsar = true
const fs = require('fs')
const ASAR = 'E:/DSH Desktop/resources/app.asar'
const want = process.argv[2]
const re = process.argv[3] ? new RegExp(process.argv[3], 'i') : null
const max = Number(process.argv[4] || 40)

const buf = fs.readFileSync(ASAR)
const headerSize = buf.readUInt32LE(12)
let hstr = buf.subarray(16, 16 + headerSize).toString('utf8')
hstr = hstr.slice(0, hstr.lastIndexOf('}') + 1)
const header = JSON.parse(hstr)
const dataOffset = 8 + headerSize
let found = null
;(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (val.files) walk(val, p)
    else if (val.offset !== undefined && p.includes(want)) found = { p, offset: Number(val.offset), size: Number(val.size) }
  }
})(header, '')
if (!found) throw new Error('asar 里没找到: ' + want)
console.log('文件:', found.p, '（', found.size, '字节）')
const text = buf.subarray(dataOffset + found.offset, dataOffset + found.offset + found.size).toString('utf8')
const lines = text.split('\n')
let n = 0
for (let i = 0; i < lines.length && n < max; i++) {
  const l = lines[i]
  if (re && !re.test(l)) continue
  if (!l.trim()) continue
  n += 1
  console.log(String(i + 1).padStart(5) + ': ' + l.trim().slice(0, 200))
}
