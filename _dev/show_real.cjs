/**
 * 打印真实上下文里的两段：系统提示正文 + 最近的插件注入块（用 JSON 包含判断，更宽容）。
 *   node _dev/show_real.cjs
 */
process.noAsar = true
const fs = require('fs')
const path = require('path')
const msgs = JSON.parse(fs.readFileSync(path.join(__dirname, 'ctx', 'messages.json'), 'utf8'))
const textOf = m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('') : String(m.content || '')
const clip = (s, n) => { const t = String(s).replace(/\s*\n\s*/g, ' ⏎ '); return t.length > n ? t.slice(0, n) + ' …' : t }

const sys = msgs.find(m => m.role === 'system' && textOf(m).length > 100)
console.log('===== 系统提示（' + (sys ? textOf(sys).length : 0) + ' 字，前 420）=====')
if (sys) console.log(textOf(sys).slice(0, 420))

const hits = []
msgs.forEach((m, i) => {
  const t = textOf(m)
  if (t.includes('<liubian-')) hits.push({ i, t, len: t.length })
})
console.log('\n===== 含 <liubian- 的消息：共 ' + hits.length + ' 条 =====')
for (const h of hits.slice(-3)) {
  console.log('\n── [' + h.i + '] role=' + msgs[h.i].role + '  ' + h.len + ' 字')
  console.log('   ' + clip(h.t, 400))
}
