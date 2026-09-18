/**
 * 把送监上下文 dump 出来（print 到屏幕 + 落盘成可手改的文件）。
 * 不调任何 API、不改任何状态，纯读会话日志 + 复用插件自己的拼装函数。
 *
 *   node _dev/dump_context.cjs [session-id 或 日志文件路径] [待审工具名] [参数JSON]
 *
 * 产物（默认写在 _dev/ctx/ 下）：
 *   ctx/messages.json    ← 送监用的消息数组（DSH 内部格式，可直接手改）
 *   ctx/instruction.txt  ← 末尾那条监察指令的完整文本（含伪造尾巴）
 *   ctx/wire.json        ← 按线格式转换后的 messages（能直接喂 chat/completions）
 */
process.noAsar = true
const fs = require('fs')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const HOME = process.env.DSH_HOME || path.join(require('os').homedir(), '.dsh')
const SESSIONS = path.join(HOME, 'sessions')
const OUT_DIR = path.join(__dirname, 'ctx')

function resolveFile(arg) {
  if (arg && fs.existsSync(arg)) return arg
  let newest = null
  for (const ws of fs.readdirSync(SESSIONS)) {
    const wsDir = path.join(SESSIONS, ws)
    if (!fs.statSync(wsDir).isDirectory()) continue
    for (const s of fs.readdirSync(wsDir)) {
      const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      const st = fs.statSync(f)
      if (arg && !s.includes(arg)) continue
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: f, session: s, mtimeMs: st.mtimeMs }
    }
  }
  if (!newest) throw new Error('找不到会话日志: ' + (arg || '(全部)'))
  return newest.file
}

/** 与宿主 deriveMessages 同源：只有这四类事件会产生消息，取事件里的 message。 */
const MSG_EVENTS = new Set(['user/message', 'system/message', 'assistant/message', 'tool/result'])

function messagesOf(records) {
  const out = []
  for (const r of records) {
    if (!MSG_EVENTS.has(r.type)) continue
    const m = r.data && r.data.message
    if (m) out.push(m)
  }
  return out
}

/** DSH 内部消息 → chat/completions 的 wire 格式（能直接发的那种）。 */
function toWire(messages) {
  const wire = []
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : []
    if (m.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
      const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.text).join('')
      const calls = blocks.filter(b => b.type === 'tool-call').map(b => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments || {}) },
      }))
      const msg = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (calls.length) msg.tool_calls = calls
      wire.push(msg)
      continue
    }
    // user / system：把 tool-result 块拆成 role:'tool' 消息，其余按 text 拼
    const results = blocks.filter(b => b.type === 'tool-result')
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    if (results.length) {
      for (const r of results) {
        const inner = Array.isArray(r.content) ? r.content.filter(b => b.type === 'text').map(b => b.text).join('') : String(r.content || '')
        wire.push({ role: 'tool', tool_call_id: r.toolCallId, content: inner })
      }
      if (text) wire.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text })
      continue
    }
    if (text || blocks.length === 0) wire.push({ role: m.role, content: text })
  }
  return wire
}

async function main() {
  const arg = process.argv[2]
  const toolName = process.argv[3] || 'pwsh'
  let toolArgs = { command: 'Get-Date' }
  if (process.argv[4]) toolArgs = JSON.parse(process.argv[4])

  const file = resolveFile(arg)
  const { text, frames } = dec.decodeSessionFile(file)
  const records = text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const messages = messagesOf(records)

  const implUrl = new URL('../lib/impl.mjs', `file:///${__filename.replace(/\\/g, '/')}`).href
  const mod = await import(implUrl)
  const cfg = mod.loadConfig({})
  const criteria = mod.loadCriteria(cfg)
  const sanitized = mod.sanitizeForTwin(messages)
  const instruction = mod.buildInstruction(criteria.doc, mod.describeTarget('tool', { name: toolName, arguments: toolArgs }), {
    turn: '?', step: '?',
    userInstruction: mod.lastUserInstruction(sanitized),
    prefill: cfg.twinPrefill,
  })
  const withInstruction = [...sanitized, mod.__test.userMessage(instruction, 'instructions')]

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'messages.json'), JSON.stringify(sanitized, null, 2), 'utf8')
  fs.writeFileSync(path.join(OUT_DIR, 'instruction.txt'), instruction, 'utf8')
  fs.writeFileSync(path.join(OUT_DIR, 'wire.json'), JSON.stringify(toWire(withInstruction), null, 2), 'utf8')

  // ── print 区：全部打出来，方便直接看/改 ──
  console.log('会话日志 :', file)
  console.log('帧/记录  :', frames, '/', records.length)
  console.log('判据     :', criteria.ok ? `${criteria.path}（${criteria.doc.items.length} 条）` : `不可用 ${criteria.error}`)
  console.log('消息条数 :', messages.length, '→ sanitize 后', sanitized.length)
  const counts = {}
  for (const m of sanitized) counts[m.role] = (counts[m.role] || 0) + 1
  console.log('角色计数 :', JSON.stringify(counts))
  console.log('末尾三条 :')
  for (const m of sanitized.slice(-3)) {
    const kinds = (Array.isArray(m.content) ? m.content : []).map(b => b.type).join(',')
    const first = (Array.isArray(m.content) ? m.content : []).find(b => b.type === 'text')
    console.log(`  role=${m.role} blocks=[${kinds}] id=${m.id || '-'} src=${JSON.stringify(m.source || null)} text=${JSON.stringify(String(first && first.text || '').slice(0, 80))}`)
  }
  console.log('\n===== 监察指令（末尾那条，含伪造尾巴）=====\n')
  console.log(instruction)
  console.log('\n===== 产物 =====')
  console.log(' ', path.join(OUT_DIR, 'messages.json'), '（送监消息数组，DSH 内部格式，可手改）')
  console.log(' ', path.join(OUT_DIR, 'instruction.txt'), '（监察指令全文）')
  console.log(' ', path.join(OUT_DIR, 'wire.json'), '（已转成 chat/completions 能直发的 messages）')
}

main().catch(err => {
  console.error('dump 失败：', (err && err.stack) || err)
  process.exitCode = 1
})
