/**
 * 修补"监察记录缺 reasoning 块"的历史记录：给这类 assistant/message 补一个 reasoning 块
 * （思考模式下上游要求每条 assistant 都回传 reasoning_content，缺了整条会话之后每轮请求都被拒）。
 * 只改这一条记录的内容，不删记录、不动 seq。
 *
 *   node _dev/repair_reasoning.cjs <session-id 片段>            # 演练
 *   node _dev/repair_reasoning.cjs <session-id 片段> --apply    # 落地（先备份、原子替换、五点自检）
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('node:zlib')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const frag = process.argv[2]
const apply = process.argv.includes('--apply')

let file = null
for (const ws of fs.readdirSync(SESSIONS)) {
  const d = path.join(SESSIONS, ws)
  if (!fs.statSync(d).isDirectory()) continue
  for (const s of fs.readdirSync(d)) if (s.includes(frag)) { const f = path.join(d, s, 'session.v3.jsonl.zstd'); if (fs.existsSync(f)) file = f }
}
if (!file) throw new Error('找不到会话 ' + frag)

function frameLength(b, off) {
  let p = off
  const magic = b.readUInt32LE(p)
  if ((magic & 0xffffffF0) === 0x184d2a50) return 8 + b.readUInt32LE(p + 4)
  if (magic !== 0xfd2fb528) throw new Error('不是 zstd 帧')
  p += 4
  const fhd = b[p]; p += 1
  const fcs = fhd >> 6, single = (fhd >> 5) & 1, ck = (fhd >> 2) & 1, dict = fhd & 3
  if (!single) p += 1
  p += [0, 1, 2, 4][dict]
  p += fcs === 0 ? (single ? 1 : 0) : [2, 4, 8][fcs - 1]
  for (;;) {
    const bh = b.readUInt32LE(p) & 0xffffff
    const last = bh & 1, bt = (bh >> 1) & 3, bs = (bh >> 3) & 0x1fffff
    p += 3
    if (bt === 0) p += bs
    else if (bt === 1) p += 1
    else if (bt === 2) p += bs
    else throw new Error('保留 block')
    if (last) break
  }
  if (ck) p += 4
  return p - off
}
const decodeFrames = buf => {
  const out = []
  let off = 0
  while (off < buf.length - 3) {
    const len = frameLength(buf, off)
    out.push(zlib.zstdDecompressSync(buf.subarray(off, off + len)).toString('utf8'))
    off += len
  }
  return out
}

const buf = fs.readFileSync(file)
const parts = decodeFrames(buf)
const lines = parts.join('').split('\n').filter(l => l.trim())
const recs = lines.map(l => JSON.parse(l))
const seqsBefore = recs.map(r => r.seq)
let fixed = 0
for (const r of recs) {
  if (r.type !== 'assistant/message') continue
  const m = r.data?.message
  const blocks = Array.isArray(m?.content) ? m.content : []
  const isTwin = blocks.some(b => b?.type === 'text' && String(b.text || '').startsWith('〔监察〕'))
  const hasReasoning = blocks.some(b => b?.type === 'reasoning')
  if (isTwin && !hasReasoning) {
    m.content = [{ type: 'reasoning', text: '（补记：本次监察没有留下思考正文）' }, ...blocks]
    fixed += 1
  }
}
console.log('文件:', file, '| 记录', recs.length, '| 待补记录', fixed, '| 第 0 帧行数', parts[0].split('\n').filter(l => l.trim()).length)
if (!fixed) { console.log('没有需要补的记录。'); process.exit(0) }

const outLines = recs.map(r => JSON.stringify(r))
if (outLines.length !== lines.length) throw new Error('记录数变了')
if (!recs.every((r, i) => r.seq === seqsBefore[i])) throw new Error('seq 被改动了（不该动）')
const outText = outLines.join('\n') + '\n'
const chunks = []
let cur = [], size = 0
for (const line of outLines.slice(1)) {
  cur.push(line); size += Buffer.byteLength(line, 'utf8') + 1
  if (size >= 1024 * 1024) { chunks.push(cur); cur = []; size = 0 }
}
if (cur.length) chunks.push(cur)
const outBuf = Buffer.concat([zlib.zstdCompressSync(Buffer.from(outLines[0] + '\n', 'utf8')), ...chunks.map(c => zlib.zstdCompressSync(Buffer.from(c.join('\n') + '\n', 'utf8')))])
const rt = decodeFrames(outBuf).join('')
if (rt !== outText) throw new Error('往返不一致')
console.log('重打包: 帧数', 1 + chunks.length, '| 体积', outBuf.length, '（原', buf.length, '）')
if (!apply) { console.log('演练通过；加 --apply 写盘。'); process.exit(0) }
const bak = file + '.bak-reasoning-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
fs.copyFileSync(file, bak)
fs.writeFileSync(file + '.tmp', outBuf)
fs.renameSync(file + '.tmp', file)
console.log('已修复。备份:', bak)
