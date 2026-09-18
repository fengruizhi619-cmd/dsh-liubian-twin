/**
 * 看一条会话的：坏点的真实本地时间、末尾几条记录（含 turn/end 的 error）。
 *   node _dev/peek_session.cjs <session-id 片段>
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createRequire } = require('node:module')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const frag = process.argv[2] || ''
let hit = null
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    if (frag && !s.includes(frag)) continue
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) hit = { f, s, ws }
  }
}
if (!hit) throw new Error('找不到会话: ' + frag)
const local = ms => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 23) + ' (北京)'
const recs = dec.decodeSessionFile(hit.f).text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log('会话:', hit.s, '| 所在工作区:', hit.ws, '| 记录数:', recs.length)
const first = recs.find(r => typeof r.time === 'number')
const last = [...recs].reverse().find(r => typeof r.time === 'number')
console.log('第一条:', local(first.time), '| 最后一条:', local(last.time))

// 找带 tool-call 但缺结果的坏点
const MSG = new Set(['user/message', 'system/message', 'assistant/message', 'tool/result'])
const msgs = []
recs.forEach((r, i) => {
  if (!MSG.has(r.type)) return
  const m = r.data?.message
  if (!m) return
  msgs.push({ i, t: r.time, type: r.type, role: m.role, calls: (m.content || []).filter(b => b?.type === 'tool-call').map(b => b.id), callId: (m.content || []).find(b => b?.type === 'tool-result')?.toolCallId, src: m.source, stream: r.data?.stream ? 'has-stream' : '' })
})
for (let k = 0; k < msgs.length; k++) {
  const m = msgs[k]
  if (m.role !== 'assistant' || !m.calls.length) continue
  const need = new Set(m.calls)
  let j = k + 1
  while (j < msgs.length && msgs[j].type === 'tool/result' && need.has(msgs[j].callId)) { need.delete(msgs[j].callId); j += 1 }
  if (need.size) {
    console.log(`\n坏点 @#${m.i}  ${local(m.t)}  tool_calls=[${m.calls.join(',')}] 缺=[${[...need].join(',')}]  该消息 stream 字段=${m.stream || '无'}`)
    console.log('  紧随其后:', msgs[k + 1] ? `${msgs[k + 1].type} role=${msgs[k + 1].role} src=${JSON.stringify(msgs[k + 1].src)} stream=${msgs[k + 1].stream || '无'}` : '(无)')
  }
}
console.log('\n=== 末尾 8 条 ===')
for (const r of recs.slice(-8)) {
  const d = r.data || {}
  const m = d.message || {}
  const extra = r.type === 'turn/end' ? JSON.stringify(d.reason) : (Array.isArray(m.content) ? m.content.map(b => b.type).join(',') : '')
  console.log(`  ${local(r.time)} ${r.type} ${extra.slice(0, 200)}`)
}
