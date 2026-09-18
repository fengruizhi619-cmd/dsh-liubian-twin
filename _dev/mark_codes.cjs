/**
 * 一次性诊断脚本（_dev 专用）：从宿主日志里把"模型吐出来的标记"的**真实码点**提出来。
 * 日志里那些行是实测流的内容，比任何猜测都准；脚本只打印十六进制码点，不打印字面量。
 *
 * 用法: node mark_codes.cjs [行数] [每行侧向字符数]
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')

const logDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DSH Desktop', 'logs', 'host')
const files = fs.readdirSync(logDir).filter(f => /^dsh-.*\.log$/.test(f)).map(f => path.join(logDir, f))
const lines = []
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (line.includes('DSML')) lines.push(line)
  }
}
console.log('含 DSML 的日志行数:', lines.length)

const maxLines = Number(process.argv[2] || 3)
const side = Number(process.argv[3] || 60)

/** 把一段文本转成"ASCII 原样 + 非 ASCII 打 U+XXXX"的码点清单 */
function codes(s) {
  return [...s].map(ch => {
    const cp = ch.codePointAt(0)
    if (cp === 0x2581) return '<U+2581>'      // ▁ 词间分隔符
    if (cp < 128) return ch
    return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')
  }).join('')
}

for (const line of lines.slice(-maxLines)) {
  for (let at = line.indexOf('DSML'); at >= 0; at = line.indexOf('DSML', at + 4)) {
    const s = Math.max(0, at - side)
    const e = Math.min(line.length, at + 4 + side)
    console.log('\n--- 命中（整行长度 ' + line.length + '）---')
    console.log(codes(line.slice(s, e)))
  }
}

// 统计"特殊分隔符/私有区"字符 + 紧跟其后的 ASCII 词，看看标记词汇表长什么样
const vocab = new Map()
for (const line of lines) {
  const chars = [...line]
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0)
    const special = cp === 0x2581 || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x2500 && cp <= 0x257f) || (cp >= 0xe000 && cp <= 0xf8ff)
    if (!special) continue
    let j = i
    let word = ''
    while (j < chars.length && word.length < 20) {
      const c = chars[j].codePointAt(0)
      if (c < 128) { word += chars[j]; j += 1; continue }
      if (c === 0x2581 || (c >= 0xff00 && c <= 0xffef)) { word += '·'; j += 1; continue }
      break
    }
    const key = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') + ' ' + word.replace(/·+/g, '·')
    vocab.set(key, (vocab.get(key) || 0) + 1)
    i = j - 1
  }
}
console.log('\n=== 特殊字符 + 相邻 ASCII 词（计数）===')
for (const [k, n] of [...vocab.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(4)}  ${k}`)
