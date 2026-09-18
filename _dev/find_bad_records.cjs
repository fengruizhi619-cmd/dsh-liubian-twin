/**
 * 扫全库会话：找出"我们写的监察记录里缺 reasoning 块"的那些（会导致该会话之后每轮请求
 * 都被上游以 reasoning_content 必须回传为由拒收）。只报告，不改。
 *
 *   node _dev/find_bad_records.cjs
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const local = ms => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
let files = 0
let hits = 0
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    files += 1
    let text = ''
    try { text = dec.decodeSessionFile(f).text } catch { continue }
    if (!text.includes('〔监察〕')) continue
    const recs = text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    recs.forEach((r, i) => {
      if (r.type !== 'assistant/message') return
      const m = r.data?.message
      const blocks = Array.isArray(m?.content) ? m.content : []
      const hasReasoning = blocks.some(b => b?.type === 'reasoning')
      const isTwin = blocks.some(b => b?.type === 'text' && String(b.text || '').startsWith('〔监察〕'))
      if (isTwin && !hasReasoning) {
        hits += 1
        if (hits <= 12) console.log(`  ${s}  #${i}  ${local(r.time)}  turn=${r.data?.turn} step=${r.data?.step}  块=[${blocks.map(b => b.type).join(',')}]`)
      }
    })
  }
}
console.log(`\n扫描 ${files} 个会话：缺 reasoning 的监察记录 ${hits} 条`)
