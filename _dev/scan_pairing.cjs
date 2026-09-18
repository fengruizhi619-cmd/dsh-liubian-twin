/**
 * 扫最近若干会话，找"assistant 带 tool_calls 但后面缺 tool 结果"的坏序列，
 * 并把坏点前后的原始事件打出来（含孪生的写入）。
 *
 *   node _dev/scan_pairing.cjs [最近几条会话] [每条打印几个坏点]
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const limit = Number(process.argv[2] || 8)
const perSession = Number(process.argv[3] || 1)

const files = []
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) files.push({ f, s, ws, mtimeMs: fs.statSync(f).mtimeMs })
  }
}
files.sort((a, b) => b.mtimeMs - a.mtimeMs)

const MSG = new Set(['user/message', 'system/message', 'assistant/message', 'tool/result'])

for (const { f, s, ws, mtimeMs } of files.slice(0, limit)) {
  let recs = []
  try {
    recs = dec.decodeSessionFile(f).text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { continue }
  // 投影成消息序列（与 deriveMessages 同源）
  const msgs = []
  recs.forEach((r, i) => {
    if (!MSG.has(r.type)) return
    const m = r.data?.message
    if (!m) return
    const calls = (m.content || []).filter(b => b?.type === 'tool-call').map(b => b.id)
    const result = (m.content || []).find(b => b?.type === 'tool-result')
    msgs.push({ i, t: r.time, type: r.type, role: m.role, calls, callId: result?.toolCallId, src: m.source })
  })
  const bad = []
  for (let k = 0; k < msgs.length; k++) {
    const m = msgs[k]
    if (m.role !== 'assistant' || !m.calls.length) continue
    const need = new Set(m.calls)
    let j = k + 1
    while (j < msgs.length && msgs[j].type === 'tool/result' && need.has(msgs[j].callId)) { need.delete(msgs[j].callId); j += 1 }
    if (need.size) bad.push({ k, missing: [...need], next: msgs[k + 1] })
  }
  if (!bad.length) continue
  const since = Number(process.argv[4] || 0)
  const fresh = bad.filter(b => (msgs[b.k].t || 0) >= since)
  if (!fresh.length) continue
  console.log(`\n===== ${s}  ws=${ws}  记录 ${recs.length}  坏点 ${bad.length}（阈值后 ${fresh.length}）  (mtime ${new Date(mtimeMs).toISOString()})`)
  for (const b of fresh.slice(0, perSession)) {
    const m = msgs[b.k]
    console.log(`  坏点 @记录#${m.i} ${new Date(m.t).toISOString()}  tool_calls=[${m.calls.join(',')}] 缺=[${b.missing.join(',')}]`)
    console.log(`    紧随其后: ${b.next ? b.next.type + ' role=' + b.next.role + ' src=' + JSON.stringify(b.next.src) : '(无)'}`)
    const lo = recs.findIndex(r => r.seq === recs[0].seq) // noop
    const from = Math.max(0, m.i - 6)
    for (let x = from; x <= Math.min(recs.length - 1, m.i + 6); x++) {
      const r = recs[x]
      const d = r.data || {}
      const mm = d.message || {}
      const kinds = Array.isArray(mm.content) ? mm.content.map(b => b.type + (b.name ? ':' + b.name : '') + (b.toolCallId ? ':' + b.toolCallId : '')).join(',') : typeof mm.content
      const marker = x === m.i ? '>>' : '  '
      console.log(`    ${marker} #${x} ${new Date(r.time).toISOString().slice(11, 23)} ${r.type} role=${mm.role} src=${JSON.stringify(mm.source || d.source || null)} [${kinds}]`)
    }
  }
}
console.log('\n扫描完成，会话数:', Math.min(limit, files.length))
