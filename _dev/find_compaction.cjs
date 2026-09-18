/**
 * 查 DSH 的上下文压缩机制 + 本会话的压缩/超限现场。
 *   node _dev/find_compaction.cjs
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

/* ── A. app.asar 里谁在管压缩 ── */
const ASAR = 'E:/DSH Desktop/resources/app.asar'
const buf = fs.readFileSync(ASAR)
const headerSize = buf.readUInt32LE(12)
let hstr = buf.subarray(16, 16 + headerSize).toString('utf8')
hstr = hstr.slice(0, hstr.lastIndexOf('}') + 1)
const header = JSON.parse(hstr)
const dataOffset = 8 + headerSize
const entries = []
;(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (val.files) walk(val, p)
    else if (val.offset !== undefined) entries.push({ path: p, offset: Number(val.offset), size: Number(val.size) })
  }
})(header, '')

const KEYS = ['compaction', 'context-overflow', 'contextOverflow', 'prune', 'maxContextTokens', 'contextWindow']
const hits = []
for (const e of entries) {
  if (e.size > 4_000_000) continue
  if (!/dsh-|deepseek-ai/.test(e.path)) continue
  let t = ''
  try { t = buf.subarray(dataOffset + e.offset, dataOffset + e.offset + e.size).toString('utf8') } catch { continue }
  const found = KEYS.filter(k => t.includes(k))
  if (found.length >= 2) hits.push({ path: e.path, found, text: t })
}
console.log('=== asar：同时含两个以上压缩关键词的文件 ===')
for (const h of hits.slice(0, 8)) console.log(`  ${h.path}   [${h.found.join(', ')}]`)

console.log('\n=== 这些文件里跟"触发条件/动作"有关的行 ===')
let shown = 0
for (const h of hits.slice(0, 3)) {
  const lines = h.text.split('\n')
  console.log('── ' + h.path)
  for (let i = 0; i < lines.length && shown < 28; i++) {
    const l = lines[i]
    if (/compaction|prune|overflow|threshold|ratio|maxContext|contextWindow/i.test(l) && l.trim().length > 10 && l.length < 300) {
      shown += 1
      console.log('   ' + l.trim().slice(0, 220))
    }
  }
}

/* ── B. 本会话（最新会话）的压缩与超限记录 ── */
const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
let newest = null
for (const ws of fs.readdirSync(SESSIONS)) {
  const d = path.join(SESSIONS, ws)
  if (!fs.statSync(d).isDirectory()) continue
  for (const s of fs.readdirSync(d)) {
    const f = path.join(d, s, 'session.v3.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    const m = fs.statSync(f).mtimeMs
    if (!newest || m > newest.m) newest = { f, s, m }
  }
}
const local = ms => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
const recs = dec.decodeSessionFile(newest.f).text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log(`\n=== 本会话 ${newest.s}（记录 ${recs.length}）===`)
const types = {}
for (const r of recs) if (/compaction|prune/.test(r.type)) types[r.type] = (types[r.type] || 0) + 1
console.log('  压缩类事件：', JSON.stringify(types))
for (const r of recs.filter(r => /compaction|prune/.test(r.type)).slice(-6)) console.log(`   ${local(r.time)} ${r.type} ${JSON.stringify(r.data).slice(0, 150)}`)
const over = recs.filter(r => JSON.stringify(r).includes('maximum context length'))
console.log('  含 "maximum context length" 的记录：', over.length, '条，最后一条', over.length ? local(over.at(-1).time) : '-')
for (const r of over.slice(-2)) console.log(`   ${local(r.time)} ${r.type} ${JSON.stringify(r.data).slice(0, 220)}`)
