#!/usr/bin/env node
/**
 * 一次性诊断脚本（_dev 专用）：按宿主投影规则把会话日志还原成"发出去的 messages"，
 * 检查 OpenAI 线格式的硬约束是否被破坏：
 *   assistant 消息带 tool_calls 时，紧随其后的必须是覆盖全部 tool_call_id 的 tool 结果。
 * 命中即打印坏序列的前后窗口，用来定位是谁在 tool 结果落盘之前往会话里插了东西。
 *
 * 用法: node check_pairing.cjs <session-id 或 文件路径>
 */
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

// 注意：checklist 的 findSessionFile 只认 v0 的 session.jsonl.zstd，
// 现在会话是 session.v3.jsonl.zstd，所以这里自己找。
const fs = require('fs')
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
const { text, frames } = dec.decodeSessionFile(file)
const recs = text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log('文件:', file)
console.log('帧数:', frames, '记录数:', recs.length)

const msgs = []
recs.forEach((r, i) => {
  const d = r.data || {}
  if (r.type === 'assistant/message') {
    const m = d.message || {}
    const calls = (m.content || []).filter(b => b.type === 'tool-call').map(b => b.id)
    const kinds = (m.content || []).map(b => b.type)
    msgs.push({ i, t: r.time, kind: 'assistant', calls, kinds, src: m.source })
  } else if (r.type === 'tool/result') {
    const m = d.message || {}
    const tr = (m.content || []).find(b => b.type === 'tool-result')
    msgs.push({ i, t: r.time, kind: 'tool', callId: tr && tr.toolCallId, src: m.source })
  } else if (r.type === 'user/message') {
    const m = d.message || {}
    msgs.push({ i, t: r.time, kind: 'user', text: JSON.stringify(m.content || '').slice(0, 160), src: m.source })
  } else if (r.type === 'system/message') {
    msgs.push({ i, t: r.time, kind: 'system', src: (d.message || {}).source })
  }
})
console.log('投影出的消息条数:', msgs.length)

const fmt = m => {
  const time = new Date(m.t).toISOString().replace('T', ' ').slice(0, 23)
  const src = m.src ? (m.src.kind + (m.src.plugin ? ':' + m.src.plugin : '') + (m.src.form ? '/' + m.src.form : '') + (m.src.callId ? '/' + m.src.callId : '')) : '-'
  if (m.kind === 'assistant') return `#${m.i} ${time} assistant calls=[${(m.calls || []).join(',')}] kinds=[${(m.kinds || []).join(',')}] src=${src}`
  if (m.kind === 'tool') return `#${m.i} ${time} tool      callId=${m.callId} src=${src}`
  if (m.kind === 'user') return `#${m.i} ${time} user      src=${src} text=${m.text}`
  return `#${m.i} ${time} ${m.kind} src=${src}`
}

const bad = []
for (let k = 0; k < msgs.length; k++) {
  const m = msgs[k]
  if (m.kind !== 'assistant' || !m.calls || m.calls.length === 0) continue
  const need = new Set(m.calls)
  let j = k + 1
  const got = []
  while (j < msgs.length && msgs[j].kind === 'tool' && need.has(msgs[j].callId) && !got.includes(msgs[j].callId)) {
    got.push(msgs[j].callId)
    need.delete(msgs[j].callId)
    j++
  }
  if (need.size > 0) bad.push({ k, missing: [...need], got, next: msgs[k + 1 + got.length] })
}

console.log('\n坏序列（assistant 带 tool_calls 但后面缺 tool 结果）条数:', bad.length)
bad.slice(0, 12).forEach(b => {
  const m = msgs[b.k]
  console.log(`\n--- 坏序列 @msg#${b.k}（日志记录 #${m.i}，${new Date(m.t).toISOString()}）`)
  console.log(`    tool_calls=[${m.calls.join(',')}] 已配对=[${b.got.join(',')}] 缺=[${b.missing.join(',')}]`)
  console.log(`    紧随其后那条 = ${fmt(b.next)}`)
  for (let x = Math.max(0, b.k - 3); x <= Math.min(msgs.length - 1, b.k + 4); x++) {
    console.log('    ' + (x === b.k ? '>> ' : '   ') + fmt(msgs[x]))
  }
})
