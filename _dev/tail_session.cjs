/**
 * 看一条会话最近在干什么：最后 N 条记录（可读化）+ 最近几条人类发言原文。
 *   node _dev/tail_session.cjs <session-id 片段> [N]
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const frag = process.argv[2]
const N = Number(process.argv[3] || 40)
const local = ms => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 23)
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + ' …' : t }

let hit = null
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    if (!s.includes(frag)) continue
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) hit = { f, s, ws }
  }
}
if (!hit) throw new Error('找不到会话 ' + frag)
const recs = dec.decodeSessionFile(hit.f).text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log('会话:', hit.s, '| 记录', recs.length)

console.log('\n=== 最近 5 条人类发言 ===')
const humans = recs.filter(r => r.type === 'user/message' && r.data?.message?.source?.kind === 'user')
for (const r of humans.slice(-5)) {
  const m = r.data.message
  const text = (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
  console.log(`  [${local(r.time)}] ${clip(text, 300)}`)
}

console.log(`\n=== 最后 ${N} 条记录 ===`)
for (const r of recs.slice(-N)) {
  const d = r.data || {}
  const m = d.message || {}
  let extra = ''
  if (r.type === 'assistant/message') {
    extra = (m.content || []).map(b => b.type === 'tool-call' ? `tool:${b.name}` : `${b.type}:${clip(b.text, 120)}`).join(' | ')
  } else if (r.type === 'user/message') {
    extra = `src=${JSON.stringify(m.source)} ` + clip((m.content || []).filter(b => b.type === 'text').map(b => b.text).join(''), 200)
  } else if (r.type === 'tool/call') {
    extra = `${d.name} ${clip(d.arguments, 160)}`
  } else if (r.type === 'tool/result') {
    const tr = (m.content || []).find(b => b.type === 'tool-result')
    extra = clip(JSON.stringify(tr?.content), 200)
  } else if (r.type === 'turn/end') {
    extra = JSON.stringify(d.reason).slice(0, 200)
  } else if (r.type === 'step/start' || r.type === 'step/end') {
    extra = `turn=${d.turn} step=${d.step}`
  }
  console.log(`  ${local(r.time)} ${r.type.padEnd(17)} ${extra}`)
}
