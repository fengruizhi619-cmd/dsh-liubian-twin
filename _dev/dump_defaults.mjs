/**
 * 打印孪生当前生效的默认值 + 上下文模式相关几项，顺便验证 flatten/strip 两个新函数。
 *   node _dev/dump_defaults.cjs
 */
import { DEFAULTS, stripSpecialTokens, flattenTranscript, loadConfig } from '../lib/impl.mjs'

const cfg = loadConfig({})
const keys = Object.keys(DEFAULTS).sort()
console.log('=== DEFAULTS（' + keys.length + ' 项）===')
for (const k of keys) console.log('  ' + k.padEnd(24) + ' = ' + JSON.stringify(DEFAULTS[k]))
console.log('\n=== 当前生效 ===')
for (const k of ['twinContextMode', 'twinBackgroundChars', 'twinTranscriptMessages', 'twinStripMarkers', 'twinForge', 'twinIdleTimeoutMs', 'twinRetryMax']) {
  console.log('  ' + k.padEnd(24) + ' = ' + JSON.stringify(cfg[k]))
}

const BAR = String.fromCharCode(0xff5c)
const SEP = String.fromCharCode(0x2581)
const dirty = `正常一句话\n<${BAR}${BAR}DSML${BAR}${BAR} calls> <${BAR}${BAR}DSML${BAR}${BAR} parameter name="x">值\n<think>想了点东西</think>\n开始${SEP}调用`
const clean = stripSpecialTokens(dirty)
const codeOf = s => [...s].map(ch => { const cp = ch.codePointAt(0); return cp < 128 ? ch : 'U+' + cp.toString(16).toUpperCase() }).join('')
console.log('\n=== stripSpecialTokens 前后（码点化）===')
console.log('  前: ' + codeOf(dirty))
console.log('  后: ' + codeOf(clean))
console.log('  还残留特殊字符吗:', /[\uFF5C\u2581]|<\/?think>/i.test(clean) ? '有（不对）' : '没有（对）')

const base = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: '把 A 改成 B' }], source: { kind: 'user' } },
  { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: '先看看文件' + BAR + BAR }, { type: 'text', text: '我准备改 C' }, { type: 'tool-call', id: 'c1', name: 'edit', arguments: '{"file_path":"c.txt"}' }], source: { kind: 'model' } },
  { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '改好了' }], isError: false }], source: { kind: 'tool', callId: 'c1' } },
]
console.log('\n=== flattenTranscript 产物 ===')
console.log(flattenTranscript(base, { twinTranscriptMessages: 6, twinBackgroundChars: 0 }))
