/**
 * 实战效果报告（口径全部写明，可被复算）：
 *   A. 孪生记录按会话：审查次数 + 旧口径 vs 修复后口径的裁决分布 + 哪几条是"判反"
 *   B. 日志：落盘记录逐条列出；失败/不可用各自的文件、匹配串、时间窗、首末时间
 *   C. 配对重扫：按会话扫坏点，并标出该会话当前是否有工具调用在飞（in-flight 尾巴）
 *
 *   node _dev/effect_report.mjs
 */
process.noAsar = true
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const TWIN_DIR = path.join(HOME, 'liubian-twin', 'sessions')
const SESSIONS = path.join(HOME, 'sessions')
const LOG_DIR = path.join(process.env.APPDATA || '', 'DSH Desktop', 'logs', 'host')
const local = ms => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
const mod = await import('file:///C:/Users/Feng/.dsh/plugins/dsh-liubian-twin/lib/impl.mjs?r=' + Date.now())

/* ── B. 日志（口径：最新日志文件；匹配串 `[dsh-liubian-twin]`；类别用精确子串） ── */
const logFiles = fs.readdirSync(LOG_DIR).filter(f => /^dsh-.*\.log$/.test(f) && !f.endsWith('.error.log')).map(f => path.join(LOG_DIR, f))
const logFile = logFiles.map(f => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0].f
const twinLines = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.includes('[dsh-liubian-twin]'))
const pick = sub => twinLines.filter(l => l.includes(sub))
const mount = pick('已挂载')
const landed = pick('监察记录已落盘')
const unavailable = pick('监察不可用')
const retry = pick('监察调用失败')
console.log('【B 日志口径】文件 =', logFile)
console.log('  匹配串 = 行内含 `[dsh-liubian-twin]`；类别子串 = 已挂载 / 监察记录已落盘 / 监察不可用 / 监察调用失败')
console.log('  挂载', mount.length, '次：', mount.map(l => l.slice(0, 19)).join(' , '))
console.log('  落盘', landed.length, '条（逐条）：')
landed.forEach(l => console.log('    ' + l.slice(0, 19) + '  ' + l.split('] ').slice(2).join('] ').slice(0, 80)))
console.log('  不可用', unavailable.length, '条；首末时间：', unavailable.length ? unavailable[0].slice(0, 19) + ' → ' + unavailable[unavailable.length - 1].slice(0, 19) : '-')
console.log('  失败(进重试)', retry.length, '条；首末时间：', retry.length ? retry[0].slice(0, 19) + ' → ' + retry[retry.length - 1].slice(0, 19) : '-')
const lastMount = mount.length ? mount[mount.length - 1].slice(0, 19) : ''
if (lastMount) {
  console.log('  最后一次挂载之后的失败/不可用条数：挂载后失败', retry.filter(l => l.slice(0, 19) > lastMount).length, '，挂载后不可用', unavailable.filter(l => l.slice(0, 19) > lastMount).length)
}

/* ── A. 记录（口径：~/.dsh/liubian-twin/sessions/*.jsonl；每条一个审查；按修复后解析器重算裁决） ── */
console.log('\n【A 记录口径】目录 =', TWIN_DIR)
const rowsAll = []
for (const f of fs.existsSync(TWIN_DIR) ? fs.readdirSync(TWIN_DIR).filter(x => x.endsWith('.jsonl')) : []) {
  const p = path.join(TWIN_DIR, f)
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  for (const r of rows) {
    const stored = r.verdict?.conform
    const text = String(r.verdict?.reason || r.verdict?.correction || '')
    // 只按"存下来的那段原文"判：以「通过」开头却存成纠正（或反之）= 判反
    const t = text.trim()
    const looksConform = /^通过/.test(t)
    const looksDeny = /^纠正/.test(t)
    const flipped = (stored === false && looksConform) || (stored === true && looksDeny)
    rowsAll.push({ sid: f.replace('.jsonl', ''), time: r.time, kind: r.kind, stored, flipped, text })
  }
}
const bySession = new Map()
for (const r of rowsAll) { if (!bySession.has(r.sid)) bySession.set(r.sid, []); bySession.get(r.sid).push(r) }
for (const [sid, rows] of [...bySession.entries()].sort((a, b) => (b[1].at(-1).time - a[1].at(-1).time))) {
  if (!/^session-/.test(sid)) continue // 桩测/自检的假会话单独归类
  const oldC = rows.filter(r => r.stored === true).length
  const flipped = rows.filter(r => r.flipped)
  const trueC = oldC + rows.filter(r => r.flipped && r.stored === false).length - rows.filter(r => r.flipped && r.stored === true).length
  console.log(`\n  === ${sid}｜审查 ${rows.length} 次（最后 ${local(rows.at(-1).time)}）`)
  console.log(`      存储值口径：通过 ${oldC} / 纠正 ${rows.length - oldC}`)
  console.log(`      扣掉判反后的真实口径：通过 ${trueC} / 纠正 ${rows.length - trueC}`)
  if (flipped.length) console.log(`      ⚠ 判反 ${flipped.length} 条：` + flipped.map(r => local(r.time) + '（原文以「' + (r.stored ? '纠正' : '通过') + '」开头，却存成' + (r.stored ? '通过' : '纠正') + '）').join('；'))
  for (const r of rows) console.log(`      - ${local(r.time)} ${r.kind} 存为${r.stored ? '通过' : '纠正'}${r.flipped ? '（判反）' : ''}：${String(r.text).replace(/\s+/g, ' ').slice(0, 90)}`)
}
const fake = [...bySession.keys()].filter(s => !/^session-/.test(s))
console.log('\n  （另有桩测/自检假会话 ' + fake.length + ' 个：' + fake.join(', ') + '）')

/* ── C. 配对重扫（口径：按宿主投影规则，逐 assistant-with-calls 要求紧跟连续工具结果） ── */
console.log('\n【C 配对重扫口径】按日志投影出消息序列，逐条 assistant 检查其 tool_calls 是否被紧随的连续结果覆盖；in-flight = 该会话最后一条消息是未配齐的 assistant')
for (const sid of [...bySession.keys()].filter(s => /^session-/.test(s))) {
  let sfile = null
  for (const ws of fs.readdirSync(SESSIONS)) {
    const d = path.join(SESSIONS, ws)
    if (!fs.statSync(d).isDirectory()) continue
    for (const s of fs.readdirSync(d)) if (s.includes(sid)) sfile = path.join(d, s, 'session.v3.jsonl.zstd')
  }
  if (!sfile) { console.log(`  ${sid}：找不到会话日志`); continue }
  const recs = dec.decodeSessionFile(sfile).text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const MSG = new Set(['user/message', 'system/message', 'assistant/message', 'tool/result'])
  const msgs = recs.filter(r => MSG.has(r.type) && r.data?.message).map(r => r.data.message)
  const idsOf = m => (Array.isArray(m?.content) ? m.content : []).filter(b => b?.type === 'tool-result' && b.toolCallId).map(b => b.toolCallId)
  const badAt = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    const calls = (m.content || []).filter(b => b?.type === 'tool-call' && b.id).map(b => b.id)
    if (!calls.length) continue
    const need = new Set(calls)
    let j = i + 1
    while (j < msgs.length) { const ids = idsOf(msgs[j]); if (!ids.length) break; for (const id of ids) need.delete(id); j += 1 }
    if (need.size) badAt.push({ i, atEnd: i === msgs.length - 1 })
  }
  const inFlight = badAt.length === 1 && badAt[0].atEnd
  console.log(`  ${sid}：坏点 ${badAt.length}${inFlight ? '（唯一一个在消息序列最末 = 工具调用在飞，非写坏）' : ''}`)
}
