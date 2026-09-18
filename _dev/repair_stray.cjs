/**
 * 修掉"自检写入"留下的坏记录：删掉 turn=999/step=1 的 assistant/message（那些记录插在
 * 工具调用与工具结果之间，会让会话之后每个请求都被上游 400 拒），并把 seq 重编成连续。
 *
 *   node _dev/repair_stray.cjs <session-id 片段>            # 演练：只报告，不写
 *   node _dev/repair_stray.cjs <session-id 片段> --apply    # 落地：先备份再原子替换
 *
 * 自检：帧 0 恰好一行会话头；每帧以换行收尾；记录数 = 原数 - 删掉数；seq 连续 0..N-1；
 *      按宿主规则重投影后 tool_calls 全部配对；不含 turn=999。
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('node:zlib')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const frag = process.argv[2]
const apply = process.argv.includes('--apply')
if (!frag) { console.error('用法: node _dev/repair_stray.cjs <session-id 片段> [--apply]'); process.exit(2) }

let file = null
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    if (!s.includes(frag)) continue
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) file = f
  }
}
if (!file) throw new Error('找不到会话 ' + frag)

/** 走帧头 + block 头精确算帧长，逐帧解压 */
function frameLength(b, off) {
  let p = off
  const magic = b.readUInt32LE(p)
  if ((magic & 0xffffffF0) === 0x184d2a50) return 8 + b.readUInt32LE(p + 4)
  if (magic !== 0xfd2fb528) throw new Error('不是 zstd 帧 @' + off)
  p += 4
  const fhd = b[p]; p += 1
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dict = fhd & 3
  if (!single) p += 1
  p += [0, 1, 2, 4][dict]
  p += fcsFlag === 0 ? (single ? 1 : 0) : [2, 4, 8][fcsFlag - 1]
  for (;;) {
    const bh = b.readUInt32LE(p) & 0xffffff
    const last = bh & 1, btype = (bh >> 1) & 3, bsize = (bh >> 3) & 0x1fffff
    p += 3
    if (btype === 0) p += bsize
    else if (btype === 1) p += 1
    else if (btype === 2) p += bsize
    else throw new Error('保留 block')
    if (last) break
  }
  if (checksum) p += 4
  return p - off
}
function frames(buf) {
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
const parts = frames(buf)
const headerFrame = parts[0]
const bodyFrames = parts.slice(1)
console.log('文件:', file)
console.log('帧数:', parts.length, '| 第 0 帧行数:', headerFrame.split('\n').filter(l => l.trim()).length, '| 体积:', buf.length)

const raw = parts.join('')
const lines = raw.split('\n').filter(l => l.trim())
const recs = lines.map(l => { try { return JSON.parse(l) } catch { return null } })
if (recs.some(r => !r)) throw new Error('有解析不了的行')

const isStray = r => r.type === 'assistant/message' && r.data?.turn === 999 && r.data?.step === 1
const strayIdx = recs.map((r, i) => (isStray(r) ? i : -1)).filter(i => i >= 0)
console.log('待删除的 stray 记录:', strayIdx.map(i => '#' + i).join(', ') || '（无）')
if (!strayIdx.length) { console.log('没有需要修的记录，退出。'); process.exit(0) }

const kept = recs.filter(r => !isStray(r))
kept.forEach((r, i) => { r.seq = i })
const outLines = kept.map(r => JSON.stringify(r))
const outText = outLines.join('\n') + '\n'

// 自检 1：记录数与 seq
if (kept.length !== recs.length - strayIdx.length) throw new Error('记录数对不上')
if (kept.some((r, i) => r.seq !== i)) throw new Error('seq 不连续')
if (kept.some(isStray)) throw new Error('还有 turn=999 的记录')

// 自检 2：按宿主规则重投影，检查 tool_calls 配对
const MSG = new Set(['user/message', 'system/message', 'assistant/message', 'tool/result'])
const msgs = kept.filter(r => MSG.has(r.type) && r.data?.message).map(r => r.data.message)
const idsOf = m => (Array.isArray(m?.content) ? m.content : []).filter(b => b?.type === 'tool-result' && b.toolCallId).map(b => b.toolCallId)
let bad = 0
for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i]
  if (m.role !== 'assistant') continue
  const calls = (m.content || []).filter(b => b?.type === 'tool-call' && b.id).map(b => b.id)
  if (!calls.length) continue
  const need = new Set(calls)
  let j = i + 1
  while (j < msgs.length) { const ids = idsOf(msgs[j]); if (!ids.length) break; for (const id of ids) need.delete(id); j += 1 }
  if (need.size) { bad += 1; console.log('  仍有坏点 @消息#' + i + ' 缺=' + [...need].join(',')) }
}
console.log('重投影后坏点:', bad)
if (bad) throw new Error('还有坏点，先别写')

// 自检 3：重新打包（第 0 帧恰好一行会话头，其余按 ~1MB 分帧，每帧以换行收尾）
const headerLine = outLines[0]
const rest = outLines.slice(1)
const chunks = []
let cur = []
let size = 0
for (const line of rest) {
  cur.push(line)
  size += Buffer.byteLength(line, 'utf8') + 1
  if (size >= 1024 * 1024) { chunks.push(cur); cur = []; size = 0 }
}
if (cur.length) chunks.push(cur)
const encodeFrame = text => zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
const outBuf = Buffer.concat([
  encodeFrame(headerLine + '\n'),
  ...chunks.map(c => encodeFrame(c.join('\n') + '\n')),
])
const roundTrip = frames(outBuf).join('')
if (roundTrip !== outText) throw new Error('解压回来与写出的内容不一致')
const rtLines = roundTrip.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
if (rtLines.length !== kept.length) throw new Error('往返后记录数不一致')
console.log('重打包: 帧数', 1 + chunks.length, '| 体积', outBuf.length, '（原', buf.length, '）')

if (!apply) {
  console.log('\n演练通过；加 --apply 才会写盘。')
  process.exit(0)
}
const backup = file + '.bak-stray-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
fs.copyFileSync(file, backup)
const tmp = file + '.tmp-repair'
fs.writeFileSync(tmp, outBuf)
fs.renameSync(tmp, file)
console.log('已修复。备份:', backup)
console.log('复核:', frames(fs.readFileSync(file)).join('').split('\n').filter(l => l.trim()).length, '条记录')
