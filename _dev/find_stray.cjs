/**
 * 找"自检写入"留下的指纹：turn 999 的 assistant/message（twin_record_write 的产物）。
 *   node _dev/find_stray.cjs
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const local = ms => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
let files = 0
let hitSessions = 0
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    files += 1
    let text = ''
    try { text = dec.decodeSessionFile(f).text } catch { continue }
    if (!text.includes('"turn":999')) continue
    hitSessions += 1
    const recs = text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    console.log(`\n=== ${s}  ws=${ws}`)
    recs.forEach((r, i) => {
      if (r.data?.turn !== 999 && !(r.type === 'tool/call' && JSON.stringify(r.data).includes('twin_record_write'))) return
      const m = r.data?.message || {}
      const kinds = Array.isArray(m.content) ? m.content.map(b => b.type).join(',') : ''
      console.log(`   #${i} seq=${r.seq} ${local(r.time)} ${r.type} turn=${r.data?.turn} step=${r.data?.step} [${kinds}]`)
      if (r.type === 'tool/call') console.log(`        参数: ${String(r.data.arguments).slice(0, 120)}`)
    })
  }
}
console.log(`\n扫描 ${files} 个会话，命中 ${hitSessions} 个`)
