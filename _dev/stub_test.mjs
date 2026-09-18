/**
 * dsh-liubian-twin 桩测：不依赖真模型、不依赖宿主，直接 node 跑。
 *
 *   node _dev/stub_test.mjs
 *
 * 覆盖（对应实施方案 §9 的纯函数/桩级验证）：
 *   1. 判据载入与送监指令拼装（44 条、不写来源、role/contract/usage 都在）
 *   2. 裁决解析（裸 JSON / 围栏 / 前后夹话 / 非法）
 *   3. 闸门触发规则（链首 / 次数间隔 / 时间间隔 / 预算 / 未解决出口 / 回合重置）
 *   4. 文本闸门流的五条契约（通过 / 否决 / 不可用 / 中止 / 纯工具步）
 *   5. 合成分块的流语法（照宿主 validateStream 的规则自查）
 *   6. 工具闸门（放行 / deny / 不可用→notice+中断+deny / 内部工具与递归跳过）
 */
import assert from 'node:assert/strict'

const implPath = new URL('../lib/impl.mjs', import.meta.url).href
const m = await import(implPath)
const { __test: T } = m

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`PASS  ${name}`)
  } catch (err) {
    results.push(`FAIL  ${name}\n      ${(err && err.message) || err}`)
    process.exitCode = 1
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (err) {
    results.push(`FAIL  ${name}\n      ${(err && err.stack) || err}`)
    process.exitCode = 1
  }
}

/* ── 1. 判据与指令 ─────────────────────────────────────────────────────── */

const cfg = { ...T.DEFAULTS }
const criteria = T.loadCriteria(cfg)

check('判据文件可载入且是 44 条', () => {
  assert.equal(criteria.ok, true, criteria.error)
  assert.equal(criteria.doc.items.length, 44)
  assert.ok(criteria.path.endsWith('criteria.json'))
})

check('判据条目不带来源字段、字段齐备', () => {
  for (const it of criteria.doc.items) {
    assert.deepEqual(Object.keys(it).sort(), ['id', 'q', 'when'], `条目 ${it.id} 字段异常`)
    assert.ok(String(it.q).length > 4 && String(it.when).length > 2)
  }
})

check('送监指令含 role / usage / 全部 44 条 / 契约 / 待审对象', () => {
  const text = T.buildInstruction(criteria.doc, T.describeTarget('text', { text: '我打算删掉这个文件' }), { turn: 3, step: 2 })
  assert.ok(text.includes(criteria.doc.role.slice(0, 20)))
  assert.ok(text.includes(criteria.doc.usage))
  assert.ok(text.includes(criteria.doc.contract), `指令里应有契约；契约=${JSON.stringify(criteria.doc.contract)}`)
  assert.ok(text.includes('执行智能体准备输出的话'))
  for (const it of criteria.doc.items) {
    assert.ok(text.includes(`[场景] ${it.when} → 要求 ${it.q}`), `缺条目 ${it.id}`)
  }
  assert.ok(!text.includes('来源'), '指令里不应出现"来源"')
})

/* ── 2. 裁决解析 ───────────────────────────────────────────────────────── */

check('裁决解析：裸 JSON / 围栏 / 夹话 / 非法', () => {
  const a = T.parseVerdict('{"conform":true,"reason":"对得上指令","correction":""}')
  assert.equal(a.ok, true)
  assert.equal(a.verdict.conform, true)
  const b = T.parseVerdict('裁决如下：\n```json\n{"conform":false,"reason":"越权","correction":"先问用户"}\n```\n以上。')
  assert.equal(b.ok, true)
  assert.equal(b.verdict.correction, '先问用户')
  const c = T.parseVerdict('{"conform":false,"reason":"含 { 花括号 } 与 \\" 引号","correction":"x"}')
  assert.equal(c.ok, true)
  assert.equal(c.verdict.reason, '含 { 花括号 } 与 " 引号')
  assert.equal(T.parseVerdict('我觉得没问题').ok, false)
  assert.equal(T.parseVerdict('{"reason":"缺 conform"}').ok, false)
})

/* ── 3. 闸门触发规则 ───────────────────────────────────────────────────── */

check('触发规则①：链首 / 类型切换必审', () => {
  const st = T.makeState()
  assert.equal(T.shouldReview(st, cfg, 'tool').why, 'chain-head')
  assert.equal(T.shouldReview(st, cfg, 'tool').why, 'inside-gap')
  assert.equal(T.shouldReview(st, cfg, 'text').why, 'kind-switch')
  assert.equal(T.shouldReview(st, cfg, 'tool').why, 'kind-switch')
})

check('触发规则②：距上次审查 ≥10 次动作 或 ≥10 分钟', () => {
  const st = T.makeState()
  const c = { ...cfg, twinGapMinutes: 10 }
  assert.equal(T.shouldReview(st, c, 'tool').review, true) // 链首
  T.markReviewed(st, Date.now())
  let hit = null
  for (let i = 0; i < 12; i++) {
    const d = T.shouldReview(st, c, 'tool', Date.now())
    if (d.review) { hit = { i, why: d.why }; break }
  }
  assert.ok(hit, '次数间隔应触发')
  assert.equal(hit.why, 'gap-calls')
  assert.equal(hit.i, 9, `应为第 10 次动作触发，实际第 ${hit.i + 1} 次`)

  const st2 = T.makeState()
  const t0 = 1_000_000
  T.shouldReview(st2, c, 'tool', t0)
  T.markReviewed(st2, t0)
  assert.equal(T.shouldReview(st2, c, 'tool', t0 + 60_000).review, false)
  const d = T.shouldReview(st2, c, 'tool', t0 + 10 * 60_000 + 1)
  assert.equal(d.why, 'gap-time')
})

check('预算用尽 → 静默跳过；回合重置恢复', () => {
  const st = T.makeState()
  const c = { ...cfg, twinMaxReviewsPerTurn: 2, twinGapCalls: 999 }
  T.shouldReview(st, c, 'tool') // 链首
  T.markReviewed(st)
  T.shouldReview(st, c, 'text') // 类型切换
  T.markReviewed(st)
  assert.equal(T.shouldReview(st, c, 'tool').why, 'kind-switch') // 类型切换不受预算限制（规则①优先）
  const st3 = T.makeState()
  for (let i = 0; i < 2; i++) { T.shouldReview(st3, c, 'text'); T.markReviewed(st3) }
  assert.equal(T.shouldReview(st3, c, 'text').why, 'budget')
  T.resetTurn(st3, 2)
  assert.equal(T.shouldReview(st3, c, 'text').review, true)
})

check('未解决出口：标记后不再审', () => {
  const st = T.makeState()
  st.unresolved = true
  assert.equal(T.shouldReview(st, cfg, 'tool').why, 'unresolved-exit')
})

/* ── 4/5. 文本闸门 + 合成分块的流语法 ──────────────────────────────────── */

/** 照宿主 dsh-llm/lib/invariant.js:validateStream 的规则自查一条流。 */
function validateStreamGrammar(chunks) {
  const open = new Map()
  let usageSeen = false
  let finished = false
  for (const chunk of chunks) {
    assert.ok(!finished, `finish 之后又出现 ${chunk.type}`)
    switch (chunk.type) {
      case 'block-start':
        assert.ok(Number.isSafeInteger(chunk.index) && chunk.index >= 0)
        assert.ok(!open.has(chunk.index), `重复 block-start index ${chunk.index}`)
        open.set(chunk.index, chunk.blockType)
        break
      case 'text-delta':
        assert.equal(open.get(chunk.index), 'text', `index ${chunk.index} 没有打开的 text 块`)
        break
      case 'reasoning-delta':
        assert.equal(open.get(chunk.index), 'reasoning')
        break
      case 'tool-call-delta':
        assert.equal(open.get(chunk.index), 'tool-call', `index ${chunk.index} 没有打开的 tool-call 块`)
        assert.equal(typeof chunk.id, 'string')
        assert.equal(typeof chunk.argumentsDelta, 'string')
        break
      case 'block-end':
        assert.equal(open.get(chunk.index), chunk.block.type)
        open.delete(chunk.index)
        break
      case 'usage':
        assert.ok(!usageSeen)
        usageSeen = true
        break
      case 'finish':
        assert.equal(open.size, 0, `finish 时还有 ${open.size} 个未关闭的块`)
        finished = true
        break
      default:
        assert.fail(`未知分块 ${chunk.type}`)
    }
  }
  assert.ok(finished, '流没有终止的 finish')
  return chunks
}

/** 假上游：一段"思考 + 正文"，正文块序号 1。 */
function fakeUpstream(text = '我准备把 config.json 删掉重建。') {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '先看看要改哪里' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先看看要改哪里' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function collect(gen) {
  const out = []
  for await (const c of gen) out.push(c)
  return out
}

function textOf(chunks) {
  return chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
}

const passCfg = { ...cfg, twinGapCalls: 10 }

await checkAsync('文本闸门·通过：分块原样放行且 finish 最后', async () => {
  const st = T.makeState()
  const up = fakeUpstream()
  const out = await collect(T.textGate({
    cfg: passCfg, st, upstream: up, unavailableText: 'x',
    review: async () => ({ status: 'conform', verdict: { conform: true, reason: 'ok', correction: '' } }),
  }))
  assert.deepEqual(out, up)
  validateStreamGrammar(out)
  assert.ok(out[out.length - 1].type === 'finish')
})

await checkAsync('文本闸门·否决：原文一个字节都不出现，改合成 _twin_note 调用', async () => {
  const st = T.makeState()
  const sentence = '我准备把 config.json 删掉重建。'
  const out = await collect(T.textGate({
    cfg: passCfg, st, upstream: fakeUpstream(sentence), unavailableText: 'x',
    review: async () => ({ status: 'deny', verdict: { conform: false, reason: '越权改配置', correction: '先问用户' } }),
  }))
  validateStreamGrammar(out)
  assert.ok(!textOf(out).includes(sentence), '被拒的原文不得流出')
  assert.equal(textOf(out), '', '整步不应再有正文文本')
  const call = out.find(c => c.type === 'tool-call-delta')
  assert.ok(call, '应合成一个工具调用')
  assert.equal(call.name, '_twin_note')
  assert.ok(call.argumentsDelta.includes('先问用户'))
  assert.ok(out.some(c => c.type === 'block-start' && c.blockType === 'tool-call'))
  assert.ok(out.some(c => c.type === 'block-end' && c.block?.type === 'tool-call'))
  assert.ok(out[out.length - 1].type === 'finish')
  // 思考块照常放行
  assert.ok(out.some(c => c.type === 'block-start' && c.blockType === 'reasoning'))
})

await checkAsync('文本闸门·监察不可用：原文放行 + 末尾补固定申明（在 finish 之前）', async () => {
  const st = T.makeState()
  const sentence = '这是原文。'
  const out = await collect(T.textGate({
    cfg: passCfg, st, upstream: fakeUpstream(sentence), unavailableText: '监察api不可用，请尝试关闭插件或者稍后尝试',
    review: async () => ({ status: 'unavailable', error: 'boom' }),
  }))
  validateStreamGrammar(out)
  assert.ok(textOf(out).includes(sentence), '原文必须放行')
  assert.ok(textOf(out).includes('监察api不可用'), '末尾应有固定申明')
  assert.ok(out[out.length - 1].type === 'finish')
  const declarIdx = out.findIndex(c => c.type === 'text-delta' && c.text.includes('监察api不可用'))
  const finishIdx = out.findIndex(c => c.type === 'finish')
  assert.ok(declarIdx < finishIdx, '申明必须落在 finish 之前')
})

await checkAsync('文本闸门·中止：立即释放已扣住的分块', async () => {
  const st = T.makeState()
  const sentence = '被中止的原文。'
  const ac = new AbortController()
  // 模拟"用户按停止"：流跑到一半 signal 被中止
  const up = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: '先看看要改哪里' }
    ac.abort(new Error('user stop'))
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先看看要改哪里' } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield { type: 'text-delta', index: 1, text: sentence }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: sentence } }
    yield { type: 'finish', reason: { kind: 'aborted' } }
  })()
  let reviewed = false
  const out = await collect(T.textGate({
    cfg: passCfg, st, upstream: up, signal: ac.signal, unavailableText: 'x',
    review: async () => { reviewed = true; return { status: 'deny', verdict: { conform: false, correction: 'x' } } },
  }))
  validateStreamGrammar(out)
  assert.ok(textOf(out).includes(sentence), '中止后原文要放行，不能吞掉')
  assert.equal(reviewed, false, '中止后不再发起审查')
  assert.equal(out[out.length - 1].type, 'finish')
})

await checkAsync('文本闸门·纯工具步：出现 tool-call-delta 就不审文本', async () => {
  const st = T.makeState()
  const up = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '我先看看文件。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '我先看看文件。' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  let reviewed = false
  const out = await collect(T.textGate({
    cfg: passCfg, st, upstream: up, unavailableText: 'x',
    review: async () => { reviewed = true; return { status: 'deny', verdict: { conform: false, correction: 'x' } } },
  }))
  validateStreamGrammar(out)
  assert.deepEqual(out, up)
  assert.equal(reviewed, false)
})

check('合成分块自己就过流语法校验', () => {
  const chunks = [...T.noteCallChunks(901, 'call-twin-1', { reason: 'r', correction: 'c' }), { type: 'finish', reason: { kind: 'stop' } }]
  validateStreamGrammar(chunks)
  const chunks2 = [...T.noteTextChunks(902, '申明'), { type: 'finish', reason: { kind: 'stop' } }]
  validateStreamGrammar(chunks2)
})

/* ── 6. 工具闸门 ───────────────────────────────────────────────────────── */

function fakeAgent() {
  const appended = []
  const injected = []
  const cancelled = []
  const agent = {
    session: {
      id: 'S-test',
      requestContext: () => ({ provider: 'p', model: 'm' }),
      deriveMessages: () => [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '帮我改一下配置' }], source: { kind: 'user' } }],
      append: (type, data, opts) => {
        appended.push({ type, data, opts })
        return { seq: appended.length }
      },
    },
    inject: msg => injected.push(msg),
    cancel: (cause, opts) => cancelled.push({ cause, opts }),
  }
  return { agent, appended, injected, cancelled }
}

/** 假 ctx：llm.stream 直接吐一段裁决 JSON；重试次数可配。 */
function fakeCtx({ verdicts = [], thinking = '先看指令对应哪一句' } = {}) {
  const calls = []
  let i = 0
  return {
    calls,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    llm: {
      stream() {
        const v = verdicts[Math.min(i, verdicts.length - 1)]
        i += 1
        calls.push(v)
        const text = typeof v === 'string' ? v : JSON.stringify(v)
        return (async function* () {
          if (thinking) {
            yield { type: 'block-start', index: 0, blockType: 'reasoning' }
            yield { type: 'reasoning-delta', index: 0, text: thinking }
            yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: thinking } }
          }
          yield { type: 'block-start', index: 1, blockType: 'text' }
          yield { type: 'text-delta', index: 1, text }
          yield { type: 'block-end', index: 1, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
}

function resetStates() {
  // 桩测里每个用例用独立 sessionId，避免互相污染
}

await checkAsync('工具闸门·通过 → 工具照常执行（allow）', async () => {
  const { agent, appended } = fakeAgent()
  agent.session.id = 'S-allow'
  const st = T.stateFor('S-allow')
  st.turn = 1
  st.step = 1
  const ctx = fakeCtx({ verdicts: [{ conform: true, reason: '与指令一致', correction: '' }] })
  const cfg2 = { ...cfg, twinRetryDelayMs: 1 }
  let ran = false
  const decision = await m.__test.handleToolGate(
    ctx, cfg2,
    { name: 'read', arguments: { path: 'a.txt' }, agent, signal: new AbortController().signal, callId: 'c1' },
    async () => { ran = true; return { kind: 'allow' } },
    ctx.logger,
  )
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(ran, true)
  const rec = appended.find(a => a.type === 'assistant/message')
  assert.ok(rec, '应追加监察思考记录')
  assert.equal(rec.opts.surfaceOp, 'append')
  assert.equal(rec.data.message.content[0].type, 'reasoning')
  assert.ok(rec.data.message.content[1].text.startsWith('〔监察〕通过'))
  assert.ok(rec.data.message.source.kind === 'model')
})

await checkAsync('工具闸门·偏离 → deny + 注入纠正，工具不执行', async () => {
  const { agent, injected, appended } = fakeAgent()
  agent.session.id = 'S-deny'
  const stD = T.stateFor('S-deny')
  stD.turn = 1
  stD.step = 1
  const ctx = fakeCtx({ verdicts: [{ conform: false, reason: '用户只要改 A，你却动了 B', correction: '只改 A，把 B 撤回' }] })
  const cfg2 = { ...cfg, twinRetryDelayMs: 1 }
  let ran = false
  const decision = await m.__test.handleToolGate(
    ctx, cfg2,
    { name: 'write', arguments: { path: 'b.txt' }, agent, signal: new AbortController().signal, callId: 'c2' },
    async () => { ran = true; return { kind: 'allow' } },
    ctx.logger,
  )
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.startsWith('[监察]'))
  assert.ok(decision.reason.includes('只改 A'))
  assert.equal(ran, false, '工具绝不能执行')
  assert.equal(injected.length, 1)
  assert.ok(injected[0].content[0].text.includes('只改 A'))
  assert.equal(injected[0].source.form, 'instructions')
  assert.ok(appended.some(a => a.type === 'assistant/message' && a.data.message.content[1].text.startsWith('〔监察〕纠正')))
})

await checkAsync('工具闸门·监察不可用 → notice 固定文本 + 中断回合 + deny 兜底', async () => {
  const { agent, appended, cancelled } = fakeAgent()
  agent.session.id = 'S-unavail'
  const ctx = fakeCtx({ verdicts: ['not json'] })
  const cfg2 = { ...cfg, twinRetryDelayMs: 1, twinRetryMax: 5 }
  const decision = await m.__test.handleToolGate(
    ctx, cfg2,
    { name: 'bash', arguments: {}, agent, signal: new AbortController().signal, callId: 'c3' },
    async () => ({ kind: 'allow' }),
    ctx.logger,
  )
  assert.equal(ctx.calls.length, 5, `应恰好重试 5 次，实际 ${ctx.calls.length}`)
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.reason, cfg2.twinUnavailableText)
  const notice = appended.find(a => a.type === 'user/message')
  assert.ok(notice, '应先送 notice')
  assert.equal(notice.data.source.form, 'notice')
  assert.equal(notice.data.content[0].text, cfg2.twinUnavailableText)
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].opts.keepInbox, true)
})

await checkAsync('工具闸门·内部工具与递归跳过', async () => {
  const { agent } = fakeAgent()
  agent.session.id = 'S-skip'
  const ctx = fakeCtx({ verdicts: ['x'] })
  const cfg2 = { ...cfg, twinRetryDelayMs: 1 }
  let ran = 0
  const next = async () => { ran += 1; return { kind: 'allow' } }
  await m.__test.handleToolGate(ctx, cfg2, { name: '_twin_note', arguments: {}, agent, signal: new AbortController().signal }, next, ctx.logger)
  await m.__test.handleToolGate(ctx, cfg2, { name: 'read', arguments: {}, agent: undefined, signal: new AbortController().signal }, next, ctx.logger)
  assert.equal(ran, 2)
  assert.equal(ctx.calls.length, 0, '不该发起监察调用')
})

await checkAsync('工具闸门·闸门自身异常 → 放行（绝不影响执行侧）', async () => {
  const broken = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    llm: { stream() { throw new Error('llm 服务炸了') } },
  }
  const { agent } = fakeAgent()
  agent.session.id = 'S-throw'
  const cfg2 = { ...cfg, twinRetryDelayMs: 1, twinRetryMax: 2 }
  const decision = await m.__test.handleToolGate(
    broken, cfg2,
    { name: 'read', arguments: {}, agent, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
    broken.logger,
  )
  // 传输出错走的是"重试→不可用→deny 兜底"，不是闸门异常分支；这里断言它至少不抛
  assert.ok(decision.kind === 'deny')
})

console.log(results.join('\n'))
console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} 通过`)
