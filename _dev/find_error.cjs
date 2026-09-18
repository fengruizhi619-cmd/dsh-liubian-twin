/**
 * 找 "The reasoning_content in the thinking mode must be passed back to the API" 的现场：
 *   扫最近若干会话，谁记了这句报错；并把报错前那几步的消息序列（role/块类型/有无 reasoning）打出来。
 *
 *   node _dev/find_error.cjs [最近几个会话] [关键字]
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const limit = Number(process.argv[2] || 8)
const needle = process.argv[3] || 'reasoning_content'
const local = ms => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)

const files = []
for (const ws of fs.readdirSync(SESSIONS)) {
  const d = path.join(SESSIONS, ws)
  if (!fs.statSync(d).isDirectory()) continue
  for (const s of fs.readdirSync(d)) {
    const f = path.join(d, s, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) files.push({ f, s, mtimeMs: fs.statSync(f).mtimeMs })
  }
}
files.sort((a, b) => b.mtimeMs - a.mtimeMs)

for (const { f, s } of files.slice(0, limit)) {
  let recs = []
  try { recs = dec.decodeSessionFile(f).text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { continue }
  const hits = recs.map((r, i) => (JSON.stringify(r).includes(needle) ? i : -1)).filter(i => i >= 0)
  if (!hits.length) continue
  console.log(`\n===== ${s}  命中 ${hits.length} 处（最后 ${local(recs[hits.at(-1)].time)}）`)
  // 报错点前后：列出消息类事件的 role / 块类型 / 是否带 reasoning
  const MSG = new Set(['user/message', 'assistant/message', 'tool/result'])
  const from = Math.max(0, hits[0] - 24)
  for (let i = from; i <= Math.min(recs.length - 1, hits[0] + 4); i++) {
    const r = recs[i]
    const d = r.data || {}
    const m = d.message || {}
    const kinds = Array.isArray(m.content) ? m.content.map(b => b.type).join(',') : ''
    const hasReasoning = Array.isArray(m.content) && m.content.some(b => b.type === 'reasoning')
    let extra = ''
    if (r.type === 'turn/end') extra = JSON.stringify(d.reason).slice(0, 200)
    else if (MSG.has(r.type)) extra = `role=${m.role} [${kinds}] reasoning=${hasReasoning}`
    else if (r.type === 'tool/call') extra = `${d.name}`
    console.log(`  ${local(r.time)} #${i} ${r.type.padEnd(17)} ${extra}`)
  }
}
