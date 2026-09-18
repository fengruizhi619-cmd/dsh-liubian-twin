/**
 * 打印送监上下文里最该看的三段真文本：开头的系统提示、末尾的监察指令（首尾）。
 *   node _dev/show_head_tail.cjs
 */
process.noAsar = true
const fs = require('fs')
const path = require('path')
const w = JSON.parse(fs.readFileSync(path.join(__dirname, 'ctx', 'wire.json'), 'utf8'))
console.log('wire 条数:', w.length)
const last = w[w.length - 1]
console.log('末尾一条 role =', last.role)
console.log('\n===== [0] 系统提示（前 360 字）=====')
console.log(String(w[0].content).slice(0, 360))
console.log('\n===== 末尾监察指令（首 6 行）=====')
const lines = String(last.content).split('\n')
console.log(lines.slice(0, 6).join('\n'))
console.log(`\n…（中间 ${Math.max(0, lines.length - 12)} 行是 44 条判据，略）…\n`)
console.log('===== 末尾监察指令（末 8 行，含伪造尾巴）=====')
console.log(lines.slice(-8).join('\n'))
