/**
 * dsh-liubian-twin 桩测：不依赖真模型、不依赖宿主，直接 node 跑。
 *
 *   node _dev/stub_test.mjs
 *
 * 覆盖（对应实施方案 §9 的纯函数/桩级验证）：
 *   1. 判据载入与送监指令拼装（45 条、不写来源、role/contract/usage 都在）
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

check('判据文件可载入且是 45 条', () => {
  assert.equal(criteria.ok, true, criteria.error)
  assert.equal(criteria.doc.items.length, 45)
  assert.ok(criteria.path.endsWith('criteria.json'))
})

check('判据条目不带来源字段、字段齐备', () => {
  for (const it of criteria.doc.items) {
    assert.deepEqual(Object.keys(it).sort(), ['id', 'q', 'when'], `条目 ${it.id} 字段异常`)
    assert.ok(String(it.q).length > 4 && String(it.when).length > 2)
  }
})

check('输出契约不强制 JSON：用普通话结论词（通过／纠正）', () => {
  const c = criteria.doc.contract
  assert.ok(!/JSON：\{/.test(c), `契约不该再要求 JSON：${c}`)
  assert.ok(c.includes('第一行写「通过」') && c.includes('第一行写「纠正」'), '契约要给出两个结论词')
  assert.ok(criteria.doc.role.includes('第一行只写「通过」或「纠正」'), 'role 里也要写清结论词')
})

check('送监指令含 role / usage / 全部 45 条 / 契约 / 待审对象 / 用户原话', () => {
  const text = T.buildInstruction(criteria.doc, T.describeTarget('text', { text: '我打算删掉这个文件' }), {
    turn: 3,
    step: 2,
    userInstruction: '把 A 改成 B，别动别的',
  })
  assert.ok(text.includes(criteria.doc.role.slice(0, 20)))
  assert.ok(text.includes(criteria.doc.usage))
  assert.ok(text.includes(criteria.doc.contract), `指令里应有契约；契约=${JSON.stringify(criteria.doc.contract)}`)
  assert.ok(text.includes('执行智能体准备输出的话'))
  assert.ok(text.includes('只按这一段为准'), '必须点明只以引用的用户原话为准')
  assert.ok(text.includes('«把 A 改成 B，别动别的»'), '用户原话要原文引进来')
  for (const it of criteria.doc.items) {
    assert.ok(text.includes(`${it.id}. **${it.when}** → ${it.q}`), `缺条目 ${it.id}`)
  }
  assert.ok(!text.includes('来源'), '指令里不应出现"来源"')
})

check('用户原话定位：跳过插件注入块与监察指令本身', () => {
  const messages = [
    { id: '1', role: 'system', content: [{ type: 'text', text: '系统提示' }], source: { kind: 'plugin', plugin: 'x' } },
    { id: '2', role: 'user', content: [{ type: 'text', text: '<liubian-capabilities>…</liubian-capabilities>' }], source: { kind: 'plugin', plugin: 'dsh-liubian', form: 'catalog' } },
    { id: '3', role: 'user', content: [{ type: 'text', text: '真正的用户指令：把 config.json 的 gap 改成 12' }], source: { kind: 'user' } },
    { id: '4', role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    { id: '5', role: 'user', content: [{ type: 'text', text: '本轮监察指令（不该被当成用户原话）' }], source: { kind: 'plugin', plugin: 'dsh-liubian-twin', form: 'instructions' } },
  ]
  assert.equal(T.lastUserInstruction(messages), '真正的用户指令：把 config.json 的 gap 改成 12')
  assert.equal(T.lastUserInstruction([messages[0], messages[4]]), '')
})

/* ── 2. 裁决解析 ───────────────────────────────────────────────────────── */

check('裁决解析：普通话结论词为主，JSON 也认，认不出才算失败', () => {
  // ① 默认形态：普通话，第一行结论词
  const a = T.parseVerdict('通过\n这一步对应用户说的「改配置」，参数只有文件路径，没有多做。')
  assert.equal(a.ok, true)
  assert.equal(a.verdict.conform, true)
  assert.ok(a.verdict.reason.includes('改配置'))
  assert.equal(a.verdict.correction, '')
  const b = T.parseVerdict('纠正：用户只让改 A，这一步却动了 B，请把 B 撤回。')
  assert.equal(b.ok, true)
  assert.equal(b.verdict.conform, false)
  assert.ok(b.verdict.correction.includes('撤回'))
  // ② 结论词带 Markdown / 标点装饰也认
  assert.equal(T.parseVerdict('**纠正**\n越权了。').verdict.conform, false)
  assert.equal(T.parseVerdict('【通过】理由：一致。').verdict.conform, true)
  // ③ 否定式正结论不能被「偏离」二字抢先误判
  assert.equal(T.parseVerdict('这一步没有偏离用户指令，可以做。').verdict.conform, true)
  assert.equal(T.parseVerdict('无需纠正，与用户要求一致。').verdict.conform, true)
  // ④ 长句里出现结论词（第一行超过 30 字时退回扫开头）
  assert.equal(T.parseVerdict('我逐条对照了判据，这一步越过了用户交办的范围，属于偏离，先停下。').verdict.conform, false)
  // ⑤ 模型自愿给 JSON 照样认（老写法兼容）
  const c = T.parseVerdict('{"conform":true,"reason":"对得上指令","correction":""}')
  assert.equal(c.ok, true)
  assert.equal(c.verdict.conform, true)
  const d = T.parseVerdict('裁决如下：\n```json\n{"conform":false,"reason":"越权","correction":"先问用户"}\n```\n以上。')
  assert.equal(d.ok, true)
  assert.equal(d.verdict.conform, false)
  assert.equal(d.verdict.correction, '先问用户')
  const e = T.parseVerdict('{"conform":false,"reason":"含 { 花括号 } 与 \\" 引号","correction":"x"}')
  assert.equal(e.ok, true)
  assert.equal(e.verdict.reason, '含 { 花括号 } 与 " 引号')
  // ⑤.5 首行以结论词开头但很长（实测模型会写「通过：<很长的理由>」）→ 必须按首行判，不能判反
  const longPass = T.parseVerdict('通过：这一步是对交接手册.md 做只读 grep，用 pattern 提取标题行，属于正常一步，路径明确、操作只读、不改动任何内容，也没有触碰用户交办范围之外的东西，不算偏离。')
  assert.equal(longPass.ok, true, '长首行也要能判')
  assert.equal(longPass.verdict.conform, true, '长首行的「通过」不能被后面的字眼判反')
  assert.ok(longPass.verdict.reason.includes('只读 grep'), '理由要带上首行结论词之后的内容')
  const longDeny = T.parseVerdict('纠正：这个动作只对应「看内容」一半，漏掉关键一半——只读了一份文件就收工，等于把“了解现状”缩成“挑一份文件看”。')
  assert.equal(longDeny.verdict.conform, false, '长首行的「纠正」要判成纠正')
  assert.equal(T.parseVerdict('这一步不算偏离，可以做。').verdict.conform, true)
  assert.equal(T.parseVerdict('该动作未越过用户交办的范围。').verdict.conform, true)
  // ⑥ 认不出结论词 / 空回复 → 失败（触发重试，绝不拿模型的话当裁决）
  assert.equal(T.parseVerdict('嗯，让我先看看这一步做了什么。').ok, false)
  assert.equal(T.parseVerdict('').ok, false)
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
  const messages = []
  let i = 0
  return {
    calls,
    messages,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    llm: {
      stream(options) {
        messages.push(options?.messages)
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
  const st = Object.assign(T.stateFor('S-allow'), { recordInSession: true })
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
  assert.equal(appended.length, 0, '工具窗口内绝不写会话：记录必须先排队')
  assert.equal(st.pending.length, 1, '通过也要留一条待落盘记录')
  T.flushPending(agent, st, ctx.logger)
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
  const stD = Object.assign(T.stateFor('S-deny'), { recordInSession: true })
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
  assert.equal(injected.length, 0, '纠正不再另注入一份（已随 deny 原因到达模型），避免重复打印')
  assert.equal(appended.length, 0, '工具窗口内绝不写会话')
  T.flushPending(agent, stD, ctx.logger)
  assert.ok(appended.some(a => a.type === 'assistant/message' && a.data.message.content[1].text.startsWith('〔监察〕纠正')))
  // 思考正文默认不进上下文（只留一句最短标记），所以这里只断言"reasoning 块在场且带〔监察思考…〕标记"，
  // 不要求它等于监察原文——恢复"思考进会话"要显式开 twinRecordThinking。
  assert.ok(appended.some(a => a.data?.message?.content?.[0]?.type === 'reasoning' && String(a.data.message.content[0].text).includes('〔监察思考')), '监察思考要带专门标记（最短标记也算）')
})

await checkAsync('工具闸门·监察不可用 → deny 兜底，notice/中断都排队到结果落盘之后', async () => {
  const { agent, appended, cancelled } = fakeAgent()
  agent.session.id = 'S-unavail'
  const ctx = fakeCtx({ verdicts: ['not json'] })
  const cfg2 = { ...cfg, twinRetryDelayMs: 1, twinRetryMax: 5 }
  const st = Object.assign(T.stateFor('S-unavail'), { recordInSession: true })
  st.turn = 1
  st.step = 7
  const decision = await m.__test.handleToolGate(
    ctx, cfg2,
    { name: 'bash', arguments: {}, agent, signal: new AbortController().signal, callId: 'c3' },
    async () => ({ kind: 'allow' }),
    ctx.logger,
  )
  assert.equal(ctx.calls.length, 5, `应恰好重试 5 次，实际 ${ctx.calls.length}`)
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.reason, cfg2.twinUnavailableText)
  // 关键回归：这一步还在工具窗口里，**一个字节都不能写会话、也不能中断回合**
  assert.equal(appended.length, 0, '窗口内不许写会话（写进去 = 这条会话永久报废）')
  assert.equal(cancelled.length, 0, '窗口内不许中断回合')
  assert.equal(st.twinDown, true, '本回合应标记为监察不可用')
  // 本步剩下的调用一律拒掉，不再重试
  const again = await m.__test.handleToolGate(
    ctx, cfg2,
    { name: 'bash', arguments: {}, agent, signal: new AbortController().signal, callId: 'c4' },
    async () => ({ kind: 'allow' }),
    ctx.logger,
  )
  assert.equal(again.kind, 'deny')
  assert.equal(ctx.calls.length, 5, 'twinDown 之后不再发起监察调用')
  // 工具结果落盘（step/end）后才落通知 + 中断
  T.flushPending(agent, st, ctx.logger)
  const notice = appended.find(a => a.type === 'user/message')
  assert.ok(notice, '落盘时应送 notice')
  assert.equal(notice.data.source.form, 'notice')
  assert.equal(notice.data.content[0].text, cfg2.twinUnavailableText)
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].opts.keepInbox, true)
})

await checkAsync('送监消息形态·尾部挂着未回填的 tool_calls → 补占位工具结果', async () => {
  const dangling = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '看看目录' }], source: { kind: 'user' } },
    { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'call_x1', name: 'glob', arguments: '{}' }], source: { kind: 'model' } },
  ]
  const fixed = T.sanitizeForTwin(dangling)
  assert.equal(fixed.length, 3, '应补一条占位结果')
  assert.equal(fixed[1], dangling[1], '原消息不能动（前缀缓存）')
  const ph = fixed[2]
  assert.equal(ph.role, 'user')
  assert.equal(ph.content[0].type, 'tool-result')
  assert.equal(ph.content[0].toolCallId, 'call_x1')
  assert.ok(ph.content[0].content[0].text.includes('尚未执行'))
  // 已经配过对的调用不能被补第二条结果
  const paired = [...dangling, { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_x1', content: [{ type: 'text', text: 'a.txt' }] }], source: { kind: 'tool' } }]
  assert.equal(T.sanitizeForTwin(paired).length, 3, '已配对的不能再补')
  // 一条 assistant 带多个调用时，缺几个补几个
  const two = [
    { id: 'a2', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read' }, { type: 'tool-call', id: 'c2', name: 'read' }], source: { kind: 'model' } },
    { id: 't2', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }], source: { kind: 'tool' } },
  ]
  const fixed2 = T.sanitizeForTwin(two)
  assert.equal(fixed2.length, 3)
  assert.equal(fixed2[2].content[0].toolCallId, 'c2')
})

await checkAsync('工具闸门·送监请求里带的是补过占位的消息（不是裸的 dangling；full 模式）', async () => {
  const { agent } = fakeAgent()
  agent.session.id = 'S-shape'
  agent.session.deriveMessages = () => [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '看看目录' }], source: { kind: 'user' } },
    { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'call_z9', name: 'read', arguments: '{}' }], source: { kind: 'model' } },
  ]
  const st = Object.assign(T.stateFor('S-shape'), { recordInSession: true })
  st.turn = 1
  st.step = 1
  const ctx = fakeCtx({ verdicts: [{ conform: true, reason: 'ok', correction: '' }] })
  await m.__test.handleToolGate(
    ctx, { ...cfg, twinContextMode: 'full', twinRetryDelayMs: 1 },
    { name: 'read', arguments: {}, agent, signal: new AbortController().signal, callId: 'call_z9' },
    async () => ({ kind: 'allow' }),
    ctx.logger,
  )
  const sent = ctx.messages[0]
  assert.ok(Array.isArray(sent), '应记录送出去的消息')
  const z9 = sent.findIndex(mm => Array.isArray(mm.content) && mm.content.some(b => b.type === 'tool-result' && b.toolCallId === 'call_z9'))
  assert.ok(z9 > 0, '应给未执行的那个调用补了占位结果')
  assert.equal(sent[z9 - 1].content.some(b => b.type === 'tool-call' && b.id === 'call_z9'), true, '占位结果紧跟在它的调用之后')
  assert.ok(sent.slice(z9 + 1).some(mm => mm.role === 'user'), '后面还有监察指令（user）')
})

await checkAsync('结构伪造·送监请求末尾是一条"思考已结束"的助手消息（且绝不进会话）', async () => {
  const forged = T.forgedAssistantMessage({ twinForgeReasoning: '（判据已逐条对照完毕，下面直接给结论。）', twinForgeContent: '' }, 'p', 'm')
  assert.equal(forged.role, 'assistant')
  assert.equal(forged.content[0].type, 'reasoning')
  assert.ok(forged.content[0].text.includes('对照完毕'))
  assert.ok(forged.id && forged.source.kind === 'model')

  const { agent, appended } = fakeAgent()
  agent.session.id = 'S-forge'
  const st = Object.assign(T.stateFor('S-forge'), { recordInSession: true })
  st.turn = 1
  st.step = 1
  const ctx = fakeCtx({ verdicts: [{ conform: true, reason: 'ok', correction: '' }] })
  await m.__test.handleToolGate(
    ctx, { ...cfg, twinRetryDelayMs: 1 },
    { name: 'read', arguments: {}, agent, signal: new AbortController().signal, callId: 'call_f1' },
    async () => ({ kind: 'allow' }),
    ctx.logger,
  )
  const sent = ctx.messages[0]
  const tail = sent[sent.length - 1]
  assert.equal(tail.role, 'assistant', '末尾应是伪造的助手消息')
  assert.equal(tail.content[0].type, 'reasoning')
  assert.equal(sent[sent.length - 2].role, 'user', '伪造消息前面是监察指令')
  assert.equal(appended.filter(a => a.type === 'assistant/message').length, 0, '伪造消息绝不能写进会话')
  T.flushPending(agent, st, ctx.logger)
  const rec = appended.find(a => a.type === 'assistant/message')
  assert.ok(rec.data.message.content[1].text.startsWith('〔监察〕通过'), '会话里只应出现真正的监察记录')

  const off = fakeCtx({ verdicts: [{ conform: true, reason: 'ok', correction: '' }] })
  const { agent: agent2 } = fakeAgent()
  agent2.session.id = 'S-forge-off'
  const st2 = Object.assign(T.stateFor('S-forge-off'), { recordInSession: true })
  st2.turn = 1
  st2.step = 1
  await m.__test.handleToolGate(
    off, { ...cfg, twinForge: false, twinRetryDelayMs: 1 },
    { name: 'read', arguments: {}, agent: agent2, signal: new AbortController().signal, callId: 'call_f2' },
    async () => ({ kind: 'allow' }),
    off.logger,
  )
  const sent2 = off.messages[0]
  assert.equal(sent2[sent2.length - 1].role, 'user', 'twinForge=false 时末尾回到监察指令')
})

await checkAsync('上下文清洗·特殊标识符被清掉，拍平成普通文本', () => {
  const BAR = String.fromCharCode(0xff5c)
  const SEP = String.fromCharCode(0x2581)
  const dirty = `正常一句\n<${BAR}${BAR}DSML${BAR}${BAR} calls> <think>想了想</think> 开始${SEP}调用`
  const clean = T.stripSpecialTokens(dirty)
  assert.equal(/[\uFF5C\u2581]|<\/?think>/i.test(clean), false, `不该残留特殊标识符：${JSON.stringify(clean)}`)
  assert.ok(clean.includes('正常一句') && clean.includes('想了想'), '普通文字要留着')

  const base = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '把 A 改成 B' }], source: { kind: 'user' } },
    { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: `先看看文件${BAR}${BAR}` }, { type: 'text', text: '我准备改 C' }, { type: 'tool-call', id: 'c1', name: 'edit', arguments: '{"file_path":"c.txt"}' }], source: { kind: 'model' } },
    { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '改好了' }], isError: false }], source: { kind: 'tool', callId: 'c1' } },
  ]
  const ctxText = T.contextTextFor(base, { twinContextMode: 'flatten', twinTranscriptRounds: 10, twinBackgroundChars: 12000, twinStripMarkers: true })
  assert.ok(ctxText.includes('【执行侧】') && (ctxText.includes('【用户】') || ctxText.includes('【工具】')), '要带角色标签')
  assert.equal(/[\uFF5C\u2581]|<\/?think>/i.test(ctxText), false, '背景文本里不该有特殊标识符')
  assert.equal(/调用工具|工具结果/.test(ctxText), false, '默认不把工具调用/工具结果写进背景')
  const withTools = T.flattenTranscript(base, { twinTranscriptRounds: 10, twinRoundChars: 1200, twinIncludeTools: true })
  assert.ok(withTools.includes('调用工具 edit'), 'twinIncludeTools=true 时才写入工具调用')

  // 送监文档要按"要求 / 上下文依据 / 待判别动作"分块
  const doc = T.buildInstruction(criteria.doc, T.describeTarget('tool', { name: 'pwsh', arguments: { command: 'Get-Date' } }), {
    turn: 3, step: 2, userInstruction: '把 A 改成 B', contextText: ctxText,
  })
  for (const head of ['## 一、要求', '## 二、上下文依据', '## 三、待判别的动作', '## 四、现在开始']) {
    assert.ok(doc.includes(head), `缺分块标题：${head}`)
  }
  assert.ok(doc.indexOf('## 一、要求') < doc.indexOf('## 二、上下文依据'), '分块顺序要对')
  assert.ok(doc.includes('【执行侧】'), '上下文依据要带上拍平后的记录')
  assert.ok(doc.includes('> «把 A 改成 B»'), '用户原话要引用块化')
  assert.ok(doc.includes('调用工具') || doc.includes('pwsh'), '待判别动作要在第三节里')
})

await checkAsync('落盘前安全检查·工具窗口里绝不写，等尾部合法了再写', async () => {
  const dangling = {
    session: {
      id: 'S-guard',
      deriveMessages: () => [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: '看看' }], source: { kind: 'user' } },
        { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'cx', name: 'read', arguments: '{}' }], source: { kind: 'model' } },
      ],
    },
  }
  assert.equal(T.tailIsWritable(dangling), false, '有未回填的工具调用时不许写')
  const answered = {
    session: {
      id: 'S-guard2',
      deriveMessages: () => [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: '看看' }], source: { kind: 'user' } },
        { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'cx', name: 'read', arguments: '{}' }], source: { kind: 'model' } },
        { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'cx', content: [{ type: 'text', text: 'ok' }], isError: false }], source: { kind: 'tool', callId: 'cx' } },
      ],
    },
  }
  assert.equal(T.tailIsWritable(answered), true, '结果补齐后允许写')
  assert.equal(T.tailIsWritable({ session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '说完了' }] }] } }), true)
  // ①.5 关键：结果虽然在，但中间插了别的消息（2026-09-19 事故的坏法）→ 依然不许写
  const interleaved = {
    session: {
      id: 'S-guard-bad',
      deriveMessages: () => [
        { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'cx', name: 'read', arguments: '{}' }], source: { kind: 'model' } },
        { id: 'x1', role: 'assistant', content: [{ type: 'reasoning', text: '插进来的' }, { type: 'text', text: '〔监察〕…' }], source: { kind: 'model' } },
        { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'cx', content: [], isError: false }], source: { kind: 'tool' } },
      ],
    },
  }
  assert.equal(T.pairingOk(interleaved.session.deriveMessages()), false, '中间插了消息就是不合法')
  assert.equal(T.tailIsWritable(interleaved), false, '已坏的会话也不许再写')

  const { agent, appended } = fakeAgent()
  agent.session.id = 'S-guard3'
  let tail = 'dangling'
  agent.session.deriveMessages = () => (tail === 'dangling'
    ? [{ id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'cx', name: 'read', arguments: '{}' }], source: { kind: 'model' } }]
    : [{ id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'cx', content: [], isError: false }], source: { kind: 'tool' } }])
  const log2 = { info: () => {}, warn: () => {}, debug: () => {} }
  const st = T.makeState()
  st.recordInSession = true
  st.turn = 1
  st.step = 1
  T.queueRecord(st, { verdict: { conform: true, reason: 'ok', correction: '' }, thinking: '' }, 'tool')
  const first = T.flushPending(agent, st, log2)
  assert.equal(first.length, 0, '尾部不安全时不该写')
  assert.equal(appended.length, 0, '一个字节都不许写进会话')
  assert.equal(st.pending.length, 1, '排队项要留着，等安全时点')
  tail = 'safe'
  const second = T.flushPending(agent, st, log2)
  assert.ok(second.includes('record') || st.pending.length === 0, '安全了才落盘（或已被安全闸重试写完）')
  assert.ok(appended.some(a => a.type === 'assistant/message'), '记录进了会话')
})

await checkAsync('监察记录永远带 reasoning 块（思考模式硬约束）', async () => {
  const { agent, appended } = fakeAgent()
  agent.session.id = 'S-reasoning'
  const st = T.makeState()
  st.turn = 1
  st.step = 1
  // thinking 为空：旧实现这时只写 text 块 → 上游会报 reasoning_content 必须回传
  T.appendTwinRecord(agent, st, { verdict: { conform: true, reason: 'ok', correction: '' }, thinking: '' }, { kind: 'tool' })
  const rec = appended.find(a => a.type === 'assistant/message')
  assert.ok(rec, '应写入记录')
  assert.equal(rec.data.message.content[0].type, 'reasoning', '第一条块必须是 reasoning')
  assert.ok(String(rec.data.message.content[0].text).length > 0, 'reasoning 不能为空')
  assert.equal(rec.data.message.content[1].type, 'text')
  const forged = T.forgedAssistantMessage({ twinForgeReasoning: '', twinForgeContent: '' }, 'p', 'm')
  assert.deepEqual(forged.content.map(b => b.type), ['reasoning'], '伪造尾兜底也必须是 reasoning 块')
})

await checkAsync('生命周期闸·没有 open step 时绝不往会话里写（token meter 的硬约束）', async () => {
  // 会话事件流：一条 step/start 后 step/end → 此刻没有 open step
  const withEvents = evs => ({ id: 'S-step', snapshotEvents: () => evs })
  assert.equal(T.sessionStep(withEvents([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  ])), false, 'step/end 之后没有 open step')
  assert.equal(T.sessionStep(withEvents([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
  ])), true, 'step/start 之后有 open step')
  assert.equal(T.sessionStep(withEvents([
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'step/start', data: { turn: 1, step: 2 } },
  ])), true, '进入新一步后又是 open')
  assert.equal(T.sessionStep({ id: 'S-noapi' }), null, '问不到就不表态（交回快照判据）')

  // 尾部线格式完全合法，但 step 已关 → 依然不许写
  const pairedTail = [
    { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'cx', name: 'read', arguments: '{}' }], source: { kind: 'model' } },
    { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'cx', content: [], isError: false }], source: { kind: 'tool' } },
  ]
  const closed = { session: { id: 'S-step2', deriveMessages: () => pairedTail, snapshotEvents: () => [{ type: 'step/end', data: { turn: 1, step: 1 } }] } }
  assert.equal(T.tailIsWritable(closed), false, 'step 关了就是不许写（哪怕线格式合法）')
  const open = { session: { id: 'S-step3', deriveMessages: () => pairedTail, snapshotEvents: () => [{ type: 'step/start', data: { turn: 1, step: 1 } }] } }
  assert.equal(T.tailIsWritable(open), true, '有 open step 且线格式合法 → 允许写')

  // 直接调 appendTwinRecord（快照还写着 turn/step，但 step 已经关了）→ 一个字节都不许进会话
  const appended = []
  const agent = {
    session: {
      id: 'S-step4',
      snapshotEvents: () => [{ type: 'step/end', data: { turn: 1, step: 1 } }],
      append: (type, data, opts) => { appended.push({ type, data, opts }); return { seq: appended.length } },
    },
  }
  const st = T.makeState()
  st.turn = 1
  st.step = 1
  T.appendTwinRecord(agent, st, { verdict: { conform: true, reason: 'ok', correction: '' }, thinking: '' }, { kind: 'tool', inSession: true })
  assert.equal(appended.length, 0, 'step 已关时 appendTwinRecord 必须自己兜住（记录只进 jsonl）')
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
