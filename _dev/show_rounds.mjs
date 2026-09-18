/**
 * 看 flatten 拍平出来的轮次结构：几轮、每轮多少字、最终文本多大。
 *   node _dev/show_rounds.mjs [session-id] [轮数] [每轮字数]
 */
process.noAsar = true
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')
const { contextTextFor, sanitizeForTwin, loadConfig } = await import('../lib/impl.mjs')

const id = process.argv[2] || ''
const rounds = Number(process.argv[3] || 10)
const perRound = Number(process.argv[4] || 1200)
const SESSIONS = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'sessions')
let newest = null
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    if (id && !s.includes(id)) continue
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    const st = fs.statSync(f)
    if (!newest || st.mtimeMs > newest.mtimeMs) newest = { f, s }
  }
}
const text = dec.decodeSessionFile(newest.f).text
const recs = text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const msgs = []
for (const r of recs) {
  if (r.type === 'agent/inbox/spliced' && Array.isArray(r.data?.inserted)) { for (const m of r.data.inserted) if (m?.role) msgs.push(m); continue }
  const m = r.data?.message
  if (m && ['user/message', 'system/message', 'assistant/message', 'tool/result'].includes(r.type)) msgs.push(m)
}
const base = sanitizeForTwin(msgs)
const humans = base.filter(m => m.role === 'user' && m.source?.kind === 'user').length
console.log('会话:', newest.s, '| 消息', base.length, '| 其中人类发言', humans)
const out = contextTextFor(base, { ...loadConfig({}), twinContextMode: 'flatten', twinTranscriptRounds: rounds, twinRoundChars: perRound, twinBackgroundChars: 0 })
console.log('轮数参数:', rounds, '| 每轮字数:', perRound, '| 拍平后总长:', out.length, '| 分段数:', out.split('\n\n———\n\n').length)
console.log('\n--- 开头 300 ---\n' + out.slice(0, 300))
console.log('\n--- 结尾 900 ---\n' + out.slice(-900))
