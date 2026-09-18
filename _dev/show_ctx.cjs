/**
 * 把送监上下文按"人看得懂"的样子节选打印（默认只看末尾若干条 + 开头一条 + 中间各类型各一条）。
 * 纯读文件，不联网、不改状态。
 *
 *   node _dev/show_ctx.cjs [--file _dev/ctx/messages.json] [--last 6] [--chars 300]
 *
 * 默认读内部格式（messages.json，带块结构）；--wire 则读 wire.json（发出去的那种形状）。
 */
process.noAsar = true
const fs = require('fs')
const path = require('path')

function argOf(name, dflt) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
const file = path.resolve(__dirname, String(argOf('file', path.join('ctx', 'messages.json'))))
const lastN = Number(argOf('last', 6))
const chars = Number(argOf('chars', 300))
const clip = (s, n = chars) => {
  const t = String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ⏎ ')
  return t.length > n ? t.slice(0, n) + ' …' : t
}

const msgs = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log('文件:', file)
console.log('消息条数:', msgs.length)
const counts = {}
for (const m of msgs) counts[m.role] = (counts[m.role] || 0) + 1
console.log('角色计数:', JSON.stringify(counts))

function show(i, tag = '') {
  const m = msgs[i]
  if (!m) return
  const blocks = Array.isArray(m.content) ? m.content : []
  const kinds = blocks.map(b => b.type).join('+') || (typeof m.content === 'string' ? 'string' : '空')
  console.log(`\n── [${i}] role=${m.role}${tag ? '  ' + tag : ''}  块=${kinds}${m.tool_calls ? '  工具调用=' + m.tool_calls.length : ''}${m.tool_call_id ? '  回给=' + m.tool_call_id : ''}`)
  if (typeof m.content === 'string') {
    console.log('   ' + clip(m.content))
    return
  }
  for (const b of blocks) {
    if (b.type === 'text') console.log('   text     : ' + clip(b.text))
    else if (b.type === 'reasoning') console.log('   reasoning: ' + clip(b.text, 160))
    else if (b.type === 'tool-call') console.log('   tool-call: ' + b.name + ' ' + clip(typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments), 200))
    else if (b.type === 'tool-result') {
      const inner = Array.isArray(b.content) ? b.content.map(x => x.text).join('') : String(b.content || '')
      console.log('   result   : ' + clip(inner))
    }
  }
}

console.log('\n================ 开头一条（系统提示）================')
show(0)
console.log('\n================ 中间取样 ================')
// 各挑一条有代表性的：插件注入块、工具调用、工具结果
const pick = kind => msgs.findIndex(m => Array.isArray(m.content) && m.content.some(b => b.type === kind))
const pluginIdx = msgs.findIndex(m => m.role === 'user' && /<(liubian|kotatsu)/.test(JSON.stringify(m.content || '').slice(0, 400)))
if (pluginIdx >= 0) show(pluginIdx, '（插件注入块样例）')
const callIdx = pick('tool-call')
if (callIdx >= 0) show(callIdx, '（工具调用样例）')
const resultIdx = pick('tool-result')
if (resultIdx >= 0) show(resultIdx, '（工具结果样例）')
console.log('\n================ 末尾 ' + lastN + ' 条（真正贴着指令的那一段）================')
for (let i = Math.max(0, msgs.length - lastN); i < msgs.length; i++) show(i)
