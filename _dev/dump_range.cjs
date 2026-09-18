#!/usr/bin/env node
/**
 * 一次性诊断脚本（_dev 专用）：打印会话日志某个记录区间内的“消息类”事件，
 * 用来肉眼核对 assistant(tool_calls) → tool 结果 → 孪生插话 的真实先后。
 *
 * 用法: node dump_range.cjs <session-id> <from> <to> [关键字]
 */
const fs = require('fs')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

function resolveFile(arg) {
  if (fs.existsSync(arg)) return arg
  const root = path.join(process.env.DSH_HOME || path.join(require('os').homedir(), '.dsh'), 'sessions')
  for (const ws of fs.readdirSync(root)) {
    const wsDir = path.join(root, ws)
    if (!fs.statSync(wsDir).isDirectory()) continue
    for (const s of fs.readdirSync(wsDir)) {
      if (!s.includes(arg)) continue
      const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
      if (fs.existsSync(f)) return f
    }
  }
  throw new Error('找不到会话: ' + arg)
}

const file = resolveFile(process.argv[2])
const from = Number(process.argv[3] || 0)
const to = Number(process.argv[4] || 1e9)
const needle = process.argv[5] || ''
const { text } = dec.decodeSessionFile(file)
const recs = text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const KEEP = new Set(['assistant/message', 'tool/result', 'user/message', 'system/message', 'turn/start', 'turn/end', 'step/start', 'step/end'])
const clip = (s, n = 220) => (s.length > n ? s.slice(0, n) + '…' : s)

recs.slice(from, to).forEach((r, k) => {
  const idx = from + k
  const raw = JSON.stringify(r)
  if (needle && !raw.includes(needle)) return
  if (!needle && !KEEP.has(r.type)) return
  const d = r.data || {}
  const time = new Date(r.time).toISOString().replace('T', ' ').slice(0, 23)
  const m = d.message || {}
  let detail = ''
  if (r.type === 'assistant/message') {
    const blocks = (m.content || []).map(b => b.type === 'tool-call' ? `tool-call(${b.id},${b.name})` : b.type + ':' + clip(String(b.text || ''), 120))
    detail = `role=${m.role} src=${JSON.stringify(m.source)} blocks=[${blocks.join(' | ')}] turn=${d.turn} step=${d.step}`
  } else if (r.type === 'tool/result') {
    const tr = (m.content || []).find(b => b.type === 'tool-result') || {}
    const txt = clip(JSON.stringify(tr.content || ''), 200)
    detail = `callId=${tr.toolCallId} src=${JSON.stringify(m.source)} content=${txt}`
  } else if (r.type === 'user/message') {
    detail = `role=${m.role} src=${JSON.stringify(m.source)} text=${clip(JSON.stringify(m.content || ''), 200)}`
  } else if (r.type === 'system/message') {
    detail = `src=${JSON.stringify(m.source)} text=${clip(JSON.stringify(m.content || ''), 160)}`
  } else {
    detail = JSON.stringify(d)
  }
  console.log(`#${idx} seq=${r.seq} ${time} ${r.type}  ${detail}`)
})
console.log('\n(总记录 ' + recs.length + ')')
