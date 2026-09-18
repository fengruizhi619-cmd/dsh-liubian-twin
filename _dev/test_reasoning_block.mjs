/**
 * 专项回归：**我们贡献的每一条助手消息都必须带 reasoning 块**。
 * 背景：上游 thinking 模式回传时缺 reasoning_content 会报
 *   `The reasoning_content in the thinking mode must be passed back to the API.`
 * 这里把三类贡献点逐条断言，防止以后新增路径时又漏掉。
 *
 *   node _dev/test_reasoning_block.mjs
 */
process.noAsar = true
import assert from 'node:assert/strict'

const m = await import(new URL('../lib/impl.mjs', import.meta.url).href)
const { __test: T } = m

const hasReasoning = msg => Array.isArray(msg?.content) && msg.content.some(b => b?.type === 'reasoning')
const isAssistant = msg => msg?.role === 'assistant'

// ① 结构伪造尾：即使把 reasoning 配空、只留 content，也必须补上 reasoning 块
const forgedA = T.forgedAssistantMessage({ twinForgeReasoning: '', twinForgeContent: '（只有正文）' }, 'p', 'm')
assert.equal(isAssistant(forgedA), true)
assert.equal(hasReasoning(forgedA), true, '伪造尾缺 reasoning 块')
assert.ok(forgedA.content.length >= 2, '正文也要在')

// ② 结构伪造尾的极端情形：两个字段都给空
const forgedB = T.forgedAssistantMessage({ twinForgeReasoning: '', twinForgeContent: '' }, 'p', 'm')
assert.equal(hasReasoning(forgedB), true, '两个字段都空时也要有 reasoning 块')

// ③ 监察记录：把 thinking 给空也要带 reasoning 块（走 appendTwinRecord 的真实构造）
const appended = []
const agent = {
  session: {
    id: 'S-reason',
    deriveMessages: () => [],
    append: (type, data) => { appended.push({ type, data }) },
  },
}
T.appendTwinRecord(agent, { turn: 1, step: 1 }, { verdict: { conform: true, reason: 'ok', correction: '' }, thinking: '', provider: 'p', model: 'm' }, { kind: 'tool', log: null })
const rec = appended.find(a => a.type === 'assistant/message')
assert.ok(rec, '应落一条记录')
assert.equal(hasReasoning(rec.data.message), true, '监察记录缺 reasoning 块')

// ④ 文本闸门否决时合成的调用分块：第一段必须是 reasoning 块
const chunks = T.noteCallChunks(900, 'call-x', { reason: 'r', correction: 'c' })
assert.equal(chunks[0].type, 'block-start', '首块应是块开始')
assert.equal(chunks[0].blockType, 'reasoning', '首块必须是 reasoning')
const reasonEnd = chunks.findIndex(c => c.type === 'block-end' && c.block?.type === 'reasoning')
const callStart = chunks.findIndex(c => c.type === 'block-start' && c.blockType === 'tool-call')
assert.ok(reasonEnd >= 0 && callStart > reasonEnd, 'reasoning 块要闭合在先，tool-call 在后')
assert.equal(chunks.some(c => c.type === 'tool-call-delta' && c.name === m.NOTE_TOOL), true, '工具调用分块不能丢')
// 块序号递增（宿主按序号拼块）
const idx = chunks.filter(c => c.type === 'block-start' || c.type === 'block-end').map(c => c.index)
assert.deepEqual(idx, [...idx].sort((a, b) => a - b), '块序号必须非递减')

console.log('PASS  三类贡献点都带 reasoning 块（伪造尾 / 监察记录 / 合成调用）')
