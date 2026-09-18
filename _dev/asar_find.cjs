/**
 * 一次性诊断脚本（_dev 专用）：在 app.asar 里定位"工具调用专用标记"的出现位置，
 * 并把每个命中点映射回它所在的文件（读 asar header 的偏移表）。
 *
 * 为什么要脚本：标记本身是一串特殊字符，直接写进命令行/聊天文本里会污染输出，
 * 所以这里用码点拼出来（String.fromCharCode），脚本源码里不含那串字面量。
 *
 * 用法: node asar_find.cjs [最多打印几个命中] [上下文字节数]
 */
process.noAsar = true // 关键：Node-as-Electron 会把 .asar 当归档拦下来，必须关掉才能按普通文件读
const fs = require('fs')
const path = require('path')

const ASAR = 'E:/DSH Desktop/resources/app.asar'
const BARS = String.fromCharCode(0xff5c, 0xff5c) // 全角竖线 ×2
const TOK = `${BARS}DSML${BARS}`

const maxHits = Number(process.argv[2] || 12)
const ctx = Number(process.argv[3] || 240)

const buf = fs.readFileSync(ASAR)
console.log('asar 体积:', (buf.length / 1048576).toFixed(1), 'MB')

// ---- asar header: pickle（4×uint32 头）后跟 JSON 目录树 ----
function readHeader(b) {
  const headerSize = b.readUInt32LE(12)
  const jsonBuf = b.subarray(16, 16 + headerSize)
  let str = jsonBuf.toString('utf8')
  const end = str.lastIndexOf('}')
  str = str.slice(0, end + 1)
  return { header: JSON.parse(str), dataOffset: 8 + headerSize }
}
const { header, dataOffset } = readHeader(buf)

/** 遍历目录树，收集 {path, offset, size} */
function walk(node, prefix, out) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (val.files) walk(val, p, out)
    else if (val.offset !== undefined) out.push({ path: p, offset: Number(val.offset), size: Number(val.size) })
  }
  return out
}
const entries = walk(header, '', []).sort((a, b) => a.offset - b.offset)
console.log('文件条目:', entries.length)

/** 某个 asar 内文件偏移 → 条目路径 */
function pathOf(absOffset) {
  let lo = 0
  let hi = entries.length - 1
  let best = ''
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const e = entries[mid]
    const start = dataOffset + e.offset
    if (start <= absOffset) {
      best = e.path
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

// ---- 逐字节找标记（用 Buffer.indexOf，避免把标记写进正则字面量）----
const needle = Buffer.from(TOK, 'utf8')
const hits = []
let from = 0
while (hits.length < 400) {
  const at = buf.indexOf(needle, from)
  if (at < 0) break
  hits.push(at)
  from = at + needle.length
}
console.log(`标记出现总次数: ${hits.length}`)

// 按文件聚合
const byFile = new Map()
for (const at of hits) {
  const p = pathOf(at)
  const rec = byFile.get(p) || { path: p, count: 0, first: at }
  rec.count += 1
  byFile.set(p, rec)
}
console.log('\n=== 按文件聚合 ===')
for (const rec of [...byFile.values()].sort((a, b) => b.count - a.count)) {
  console.log(`  ${String(rec.count).padStart(4)}  ${rec.path}`)
}

console.log('\n=== 前几个命中点的上下文 ===')
for (const at of hits.slice(0, maxHits)) {
  const p = pathOf(at)
  const s = Math.max(0, at - ctx)
  const e = Math.min(buf.length, at + ctx)
  const text = buf.subarray(s, e).toString('utf8').replace(/\u0000/g, '·')
  console.log(`\n--- @${at}  file=${p}`)
  console.log(text)
}
