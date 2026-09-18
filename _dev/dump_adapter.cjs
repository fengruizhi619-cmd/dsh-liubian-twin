/**
 * 把 DSH 的 DeepSeek 适配器里"内部消息 → 发给 API 的请求体"那段打出来。
 *   node _dev/dump_adapter.cjs [起行] [止行]
 */
process.noAsar = true
const fs = require('fs')

const ASAR = 'E:/DSH Desktop/resources/app.asar'
const TARGET = 'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js'
const codes = s => [...s].map(ch => { const cp = ch.codePointAt(0); return cp < 128 ? ch : 'U+' + cp.toString(16).toUpperCase() }).join('')

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
    else if (val.offset !== undefined && p === TARGET) found = { offset: Number(val.offset), size: Number(val.size) }
  }
})(header, '')
if (!found) throw new Error('没找到 ' + TARGET)
const text = buf.subarray(dataOffset + found.offset, dataOffset + found.offset + found.size).toString('utf8')
const lines = text.split('\n')
console.log(TARGET, '共', lines.length, '行')

const mode = process.argv[2] || 'grep'
if (mode === 'grep') {
  const pat = process.argv[3] || 'role:|content|tools|body|stream|reasoning|tool-result|function '
  const re = new RegExp(pat)
  let n = 0
  for (let i = 0; i < lines.length && n < 70; i++) {
    if (re.test(lines[i]) && lines[i].trim().length && lines[i].length < 500) {
      n += 1
      console.log(String(i + 1).padStart(5) + ': ' + codes(lines[i].trim()).slice(0, 230))
    }
  }
} else {
  const from = Number(process.argv[2] || 60)
  const to = Number(process.argv[3] || 200)
  for (let i = from - 1; i < Math.min(to, lines.length); i++) {
    console.log(String(i + 1).padStart(5) + ': ' + codes(lines[i]).slice(0, 230))
  }
}
