/**
 * 打印当前会话送监上下文里的：系统提示正文（第 2 条 system）+ 最近几条插件注入块。
 *   node _dev/show_inject.cjs
 */
process.noAsar = true
const fs = require('fs')
const path = require('path')
const msgs = JSON.parse(fs.readFileSync(path.join(__dirname, 'ctx', 'messages.json'), 'utf8'))
const clip = (s, n) => { const t = String(s).replace(/\s*\n\s*/g, ' ⏎ '); return t.length > n ? t.slice(0, n) + ' …' : t }

const systems = msgs.map((m, i) => ({ m, i })).filter(x => x.m.role === 'system')
console.log('system 消息:', systems.map(x => '[' + x.i + '] ' + String(x.m.content || '').length + '字').join('  '))
const real = systems.find(x => String(x.m.content || '').length > 100)
if (real) {
  console.log('\n===== 系统提示 [' + real.i + ']（前 400 字）=====')
  console.log(String(real.m.content).slice(0, 400))
}

const injected = []
msgs.forEach((m, i) => {
  const t = Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('') : String(m.content || '')
  if (/^<(liubian|kotatsu)/.test(t.trim())) injected.push({ i, t })
})
console.log('\n===== 插件注入块：共 ' + injected.length + ' 条，最后 3 条 =====')
for (const x of injected.slice(-3)) {
  console.log('\n── [' + x.i + '] role=user  ' + x.t.length + ' 字')
  console.log('   ' + clip(x.t, 420))
}
