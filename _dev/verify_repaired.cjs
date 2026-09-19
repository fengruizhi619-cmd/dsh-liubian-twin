/**
 * verify_repaired.cjs — 修复后的会话日志双重复核
 *   A) 复刻宿主冷读链路：多帧扫描 → 第 0 帧恰好一行 header → 每帧换行收尾 →
 *      committedBytes==inputBytes → 逐事件过 adoptSessionEvent 形状校验。
 *   B) 与备份逐条 diff：把备份的记录与修复后的记录按"去掉 seq"的内容做多重集比较，
 *      证明只少了该少的那几条、其它记录内容一字未动。
 *
 *   node verify_repaired.cjs <frag> [备份文件后缀片段]
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('node:zlib')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const frag = process.argv[2]
const bakFrag = process.argv[3] || '.bak-stray-'

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
function decodeAll(file) {
  const buf = fs.readFileSync(file)
  const planes = []
  let off = 0
  while (off < buf.length - 3) {
    const len = frameLength(buf, off)
    planes.push(zlib.zstdDecompressSync(buf.subarray(off, off + len)).toString('utf8'))
    off += len
  }
  if (off !== buf.length) throw new Error('尾部有撕裂字节 @' + off)
  return { buf, planes }
}
function shapeProblem(e) {
  const type = e.type
  if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') return null
  const data = e.data
  const record = typeof data === 'object' && data !== null ? data : undefined
  const message = type === 'user/message' ? record : record && record['message']
  if (typeof message !== 'object' || message === null || typeof message['id'] !== 'string' || message['id'] === '') return 'lacks an identified message'
  const expectedRole = type === 'assistant/message' ? 'assistant' : 'user'
  if (message['role'] !== expectedRole) return `role must be "${expectedRole}"`
  const source = message['source']
  if (typeof source !== 'object' || source === null || typeof source['kind'] !== 'string' || source['kind'] === '') return 'invalid source'
  if (!Array.isArray(message['content'])) return 'invalid content'
  if (type === 'assistant/message') return source['kind'] !== 'model' ? 'must have model source' : null
  if (type === 'user/message') return null
  if (source['kind'] !== 'tool' || typeof source['callId'] !== 'string' || source['callId'] === '') return 'must have tool source'
  const block = message['content'][0]
  if (message['content'].length !== 1 || typeof block !== 'object' || block === null || block['type'] !== 'tool-result' || !Array.isArray(block['content'])) return 'must contain one tool-result block'
  if (block['toolCallId'] !== source['callId']) return 'mismatched toolCallId'
  return null
}
function hostRead(file) {
  const { planes } = decodeAll(file)
  const f0 = planes[0]
  if (f0.length === 0 || f0.indexOf('\n') !== f0.length - 1 || f0.split('\n').filter(l => l.trim()).length !== 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
  const header = JSON.parse(f0.trim())
  let inputBytes = Buffer.byteLength(f0, 'utf8'), committedBytes = inputBytes, n = 0
  const events = []
  for (let fi = 1; fi < planes.length; fi++) {
    const t = planes[fi]
    inputBytes += Buffer.byteLength(t, 'utf8')
    if (t.length === 0 || t[t.length - 1] !== '\n') throw new Error('complete frame contains a torn JSONL record (frame ' + fi + ')')
    committedBytes += Buffer.byteLength(t, 'utf8')
    for (const line of t.split('\n')) {
      if (!line) continue
      const o = JSON.parse(line)
      n += 1
      events.push(o)
    }
  }
  if (committedBytes !== inputBytes) throw new Error('torn JSONL record')
  for (const e of events) {
    const why = shapeProblem(e)
    if (why) throw new Error('session event at seq ' + e.seq + ' ' + why)
  }
  const seqOk = events.every((e, i) => e.seq === i)
  return { header, events: n, frames: planes.length, seqOk }
}
function recordsIn(file) {
  const { planes } = decodeAll(file)
  const out = []
  for (let fi = 1; fi < planes.length; fi++) for (const l of planes[fi].split('\n')) if (l.trim()) out.push(l)
  return out
}
const stripSeq = line => { const o = JSON.parse(line); delete o.seq; return JSON.stringify(o) }

let file = null, dir = null
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    if (!s.includes(frag)) continue
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) { file = f; dir = path.dirname(f) }
  }
}
if (!file) throw new Error('找不到会话 ' + frag)
console.log('文件:', file)
try {
  const r = hostRead(file)
  console.log('A) 宿主冷读复刻：✅ OK | 记录 ' + r.events + ' | 帧 ' + r.frames + ' | seq 连续 ' + r.seqOk)
} catch (e) {
  console.log('A) 宿主冷读复刻：❌ ' + e.message)
  process.exitCode = 1
}
const baks = fs.readdirSync(dir).filter(f => f.includes(bakFrag)).sort()
if (!baks.length) { console.log('B) 没找到备份，跳过 diff'); process.exit(process.exitCode || 0) }
const cur = recordsIn(file).map(stripSeq)
for (const b of baks) {
  const old = recordsIn(path.join(dir, b)).map(stripSeq)
  const count = m => m.reduce((acc, k) => (acc.set(k, (acc.get(k) || 0) + 1), acc), new Map())
  const co = count(old), cc = count(cur)
  const removed = []
  for (const [k, v] of co) { const n = cc.get(k) || 0; for (let i = 0; i < v - n; i++) removed.push(JSON.parse(k)) }
  const added = []
  for (const [k, v] of cc) { const n = co.get(k) || 0; for (let i = 0; i < v - n; i++) added.push(JSON.parse(k)) }
  console.log('B) 对备份 ' + b + '：旧 ' + old.length + ' 条 → 新 ' + cur.length + ' 条 | 少 ' + removed.length + ' 条 | 多 ' + added.length + ' 条')
  for (const r of removed) {
    const t = new Date((r.time || 0) + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    console.log('    - ' + t + '  ' + r.type + '  turn=' + (r.data && r.data.turn) + ' step=' + (r.data && r.data.step))
  }
  if (added.length) {
    console.log('    ⚠ 出现新增记录，需人工确认：')
    for (const a of added.slice(0, 5)) console.log('      + ' + JSON.stringify(a).slice(0, 160))
    process.exitCode = 1
  }
}
