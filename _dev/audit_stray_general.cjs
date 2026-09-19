/**
 * 通用审计：找出所有会让宿主 token meter 抛
 *   "assistant/message at seq N has no matching step/start event"
 * 的"步外助手消息"，以及附带的两类线格式坏点：
 *   A) orphan-assistant：assistant/message 出现在没有任何 open step 的时刻（token meter 直接抛）
 *   B) tool-pair：assistant(tool_calls) 后面没有紧跟每个 tool_call_id 的 tool 结果（上游 400）
 *   C) turn999：历史自检工具 twin_record_write 的指纹
 *
 * 只读，不改任何文件。
 *   node audit_stray_general.cjs [sessionIdFragment]
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('node:zlib')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const frag = process.argv[2] || null

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
function local(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '?'
  return new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/** 展开 -chunks 压缩事件行，得到逻辑事件序列（与宿主 scanner 一致）；第 0 帧只有会话头，不参与 */
function decodeEvents(text) {
  const rows = text.split('\n').filter(l => l.trim())
  const events = []
  let badLines = 0
  for (const line of rows) {
    let o
    try { o = JSON.parse(line) } catch { badLines += 1; continue }
    if (o && o.type === 'session') continue // 会话头行（v3 的第 0 帧）
    if (!o || typeof o.type !== 'string' || typeof o.seq !== 'number') {
      // v0/v1 旧日志（session.jsonl.zstd）：行里没有 seq/type 信封，本判据不适用，直接跳过
      if (o && typeof o.type === 'string') continue
      badLines += 1
      continue
    }
    if (typeof o.type === 'string' && o.type.endsWith('-chunks') && typeof o.seq0 === 'number' && o.data && o.data.dt) {
      const dt = o.data.dt, texts = o.data.texts || []
      const base = { ...o.data }; delete base.dt; delete base.texts
      let seq = o.seq0
      for (let k = 0; k < dt.length; k++) {
        events.push({ type: o.type.replace(/-chunks$/, ''), seq, time: (o.time0 || 0) + dt[k], data: { ...base, ...(texts[k] !== undefined ? { text: texts[k] } : {}) } })
        seq++
      }
    } else if (typeof o.seq === 'number' && typeof o.type === 'string') {
      events.push(o)
    } else badLines += 1
  }
  return { rows, events, badLines }
}

const files = []
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    if (frag && !s.includes(frag)) continue
    for (const name of ['session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
      const f = path.join(wsDir, s, name)
      if (fs.existsSync(f)) files.push({ ws, sid: s, name, file: f })
    }
  }
}

let cleanCount = 0
const dirty = []
for (const f of files) {
  let text = ''
  try { text = frames(fs.readFileSync(f.file)).join('') } catch (e) { dirty.push({ ...f, error: e.message }); continue }
  const { events, badLines } = decodeEvents(text)
  if (!events.length) { cleanCount += 1; continue }

  // 1) 步外助手消息
  const openSteps = new Set()
  const orphans = []
  let turn999 = 0
  for (let i = 0; i < events.length; i++) {
    const r = events[i]
    const key = `${r.data && r.data.turn}/${r.data && r.data.step}`
    if (r.type === 'step/start') { openSteps.add(key); continue }
    if (r.type === 'step/end') { openSteps.delete(key); continue }
    if (r.type !== 'assistant/message') continue
    if (r.data && r.data.turn === 999 && r.data.step === 1) turn999 += 1
    if (!openSteps.has(key)) orphans.push({ idx: i, seq: r.seq, time: r.time, turn: r.data && r.data.turn, step: r.data && r.data.step })
  }

  // 2) tool_calls 配对（按宿主线格式重投影）
  const MSG = new Set(['user/message', 'system/message', 'assistant/message', 'tool/result'])
  const msgs = events.filter(r => MSG.has(r.type) && r.data && r.data.message)
  const idsOf = m => (Array.isArray(m && m.content) ? m.content : []).filter(b => b && b.type === 'tool-result' && b.toolCallId).map(b => b.toolCallId)
  const unpaird = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (!m || m.role !== 'assistant') continue
    const calls = (m.content || []).filter(b => b && b.type === 'tool-call' && b.id).map(b => b.id)
    if (!calls.length) continue
    const need = new Set(calls)
    let j = i + 1
    while (j < msgs.length) { const ids = idsOf(msgs[j]); if (!ids.length) break; for (const id of ids) need.delete(id); j += 1 }
    if (need.size) unpaird.push({ msgIdx: i, missing: [...need] })
  }

  const rec = { ...f, events: events.length, orphans, turn999, unpaird, badLines }
  if (!orphans.length && !unpaird.length && !turn999 && !badLines) cleanCount += 1
  else dirty.push(rec)
}

console.log('扫描文件数:', files.length, '| 干净:', cleanCount, '| 有问题:', dirty.length)
for (const d of dirty) {
  console.log('\n=== ' + d.ws + '/' + d.sid + '  (' + d.name + ', ' + Math.round(fs.statSync(d.file).size / 1024) + ' KB' + (d.events ? ', ' + d.events + ' 逻辑事件' : '') + ')')
  if (d.error) { console.log('  解压失败:', d.error); continue }
  if (d.badLines) console.log('  ⚠ 无法解析的行:', d.badLines)
  if (d.orphans.length) {
    console.log('  A 步外助手消息 (token meter 抛错源): ' + d.orphans.length + ' 条')
    for (const o of d.orphans.slice(0, 20)) console.log('     idx#' + o.idx + ' seq=' + o.seq + ' ' + local(o.time) + ' turn=' + o.turn + ' step=' + o.step)
    if (d.orphans.length > 20) console.log('     …还有 ' + (d.orphans.length - 20) + ' 条')
  }
  if (d.turn999) console.log('  C turn=999 自检指纹: ' + d.turn999 + ' 条')
  if (d.unpaird.length) {
    console.log('  B tool_calls 未配对: ' + d.unpaird.length + ' 处')
    for (const u of d.unpaird.slice(0, 10)) console.log('     消息#' + u.msgIdx + ' 缺 ' + u.missing.join(','))
  }
}
