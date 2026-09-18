/**
 * 看孪生的实战效果（按会话，不看全局计数）：
 *   1) ~/.dsh/liubian-twin/sessions/*.jsonl 每个会话审了几次、通过/纠正各几次、最后几条裁决原文
 *   2) 每个有记录的会话，按宿主投影规则检查 tool_calls 配对有没有被写坏
 *   3) 最近的孪生日志行（只列时间戳与关键类别，不做跨口径计数）
 *
 *   node _dev/twin_effect.cjs [最多列几个会话]
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const TWIN_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'liubian-twin', 'sessions')
const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const limit = Number(process.argv[2] || 4)
const local = ms => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)

if (!fs.existsSync(TWIN_DIR)) { console.log('还没有孪生记录目录:', TWIN_DIR); process.exit(0) }
const files = fs.readdirSync(TWIN_DIR).filter(f => f.endsWith('.jsonl')).map(f => {
  const p = path.join(TWIN_DIR, f)
  return { f, p, mtimeMs: fs.statSync(p).mtimeMs, lines: fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()) }
}).sort((a, b) => b.mtimeMs - a.mtimeMs)

console.log('孪生记录文件:', files.length, '个')
for (const rec of files) {
  const rows = rec.lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const conform = rows.filter(r => r.verdict?.conform).length
  const deny = rows.filter(r => r.verdict && !r.verdict.conform).length
  console.log(`\n=== ${rec.f.replace('.jsonl', '')}`)
  console.log(`    审查 ${rows.length} 次（通过 ${conform} / 纠正 ${deny}）｜最后活动 ${local(rec.mtimeMs)}`)
  for (const r of rows.slice(-3)) {
    const body = String(r.verdict?.conform ? r.verdict.reason : r.verdict?.correction || '').replace(/\s+/g, ' ')
    console.log(`    - ${local(r.time)} ${r.kind} ${r.verdict?.conform ? '通过' : '纠正'}：${body.slice(0, 150)}`)
  }
  // 配对检查
  const sid = rec.f.replace('.jsonl', '')
  let sfile = null
  for (const ws of fs.readdirSync(SESSIONS)) {
    const d = path.join(SESSIONS, ws)
    if (!fs.statSync(d).isDirectory()) continue
    for (const s of fs.readdirSync(d)) if (s.includes(sid)) sfile = path.join(d, s, 'session.v3.jsonl.zstd')
  }
  if (!sfile || !fs.existsSync(sfile)) { console.log('    （找不到对应会话日志）'); continue }
  let recs = []
  try { recs = dec.decodeSessionFile(sfile).text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { console.log('    （会话日志解不开）'); continue }
  const MSG = new Set(['user/message', 'system/message', 'assistant/message', 'tool/result'])
  const msgs = recs.filter(r => MSG.has(r.type) && r.data?.message).map(r => r.data.message)
  const idsOf = m => (Array.isArray(m?.content) ? m.content : []).filter(b => b?.type === 'tool-result' && b.toolCallId).map(b => b.toolCallId)
  let bad = 0
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    const calls = (m.content || []).filter(b => b?.type === 'tool-call' && b.id).map(b => b.id)
    if (!calls.length) continue
    const need = new Set(calls)
    let j = i + 1
    while (j < msgs.length) { const ids = idsOf(msgs[j]); if (!ids.length) break; for (const id of ids) need.delete(id); j += 1 }
    if (need.size) bad += 1
  }
  console.log(`    会话记录 ${recs.length} 条｜配对坏点 ${bad}`)
  if (files.indexOf(rec) >= limit - 1) break
}

// 日志：只按类别列时间戳，不跨口径相加
const logDir = path.join(process.env.APPDATA || '', 'DSH Desktop', 'logs', 'host')
const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => /^dsh-.*\.log$/.test(f)).map(f => path.join(logDir, f)) : []
const twinLines = []
for (const f of logs) for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line.includes('[dsh-liubian-twin]')) twinLines.push(line)
const cat = { mount: [], landed: [], unavailable: [], retry: [] }
for (const l of twinLines) {
  if (l.includes('已挂载')) cat.mount.push(l)
  else if (l.includes('监察记录已落盘')) cat.landed.push(l)
  else if (l.includes('监察不可用')) cat.unavailable.push(l)
  else if (l.includes('监察调用失败')) cat.retry.push(l)
}
const ts = l => l.slice(0, 19)
console.log('\n=== 孪生日志（各自独立口径）===')
console.log('挂载次数:', cat.mount.length, cat.mount.slice(-2).map(ts).join(' | '))
console.log('记录落盘:', cat.landed.length, cat.landed.slice(-3).map(l => ts(l) + ' ' + l.split('：').slice(1).join('：').slice(0, 40)).join(' | '))
console.log('审查失败(进重试):', cat.retry.length, cat.retry.slice(-2).map(l => ts(l) + ' ' + l.split('：').slice(2).join('：').slice(0, 60)).join(' | '))
console.log('判不可用:', cat.unavailable.length, cat.unavailable.slice(-2).map(ts).join(' | '))
