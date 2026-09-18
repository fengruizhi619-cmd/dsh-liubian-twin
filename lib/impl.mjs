/**
 * @dsh-external/dsh-liubian-twin —— 流变·孪生（监察）实现主体
 *
 * 单文件实现：入口壳 main.mjs 用 `?t=<时间戳>` 动态导入本文件，
 * 单文件 = 单个 URL = 整张依赖图一次刷新，改完代码热注入即生效。
 *
 * 与 dsh-liubian 的关系：**功能上不互通**（不引它的代码、不读它的数据与配置），
 * 只在命名上归流变系列。监察要看的"固定提示词"（接入卡／教训块／能力卡／逐轮提醒）
 * 本来就作为会话消息活在日志里，`session.deriveMessages()` 原样带出，
 * 所以这里一行流变代码都不需要。
 *
 * 三条实现主线：
 *   ① 工具闸门 `tools/pre-execute` —— 派发前裁决，可 deny（工具不执行，模型收到
 *      `Error: [监察] …` 被迫改道）；
 *   ② 文本闸门 `llm/stream` 包裹 —— 把该步的文本分块**扣住**，审完才放行；
 *      不通过就不放原文，改成合成一个 `_twin_note` 工具调用（用它的工具结果
 *      把纠正回给模型，模型在同一步内重写）。这是"绝对不允许边审查边输出"的唯一形态。
 *   ③ 监察思考落盘 —— 每次审查结束追加一条 assistant/message，content =
 *      [{type:'reasoning'}, {type:'text'}]，吃 DSH 原生思考行渲染，不用客户端 UI。
 *
 * 停等语义：审查期间执行侧零产出（文本扣住、工具不派发），审查必须 await。
 *
 * 止血路径：本插件没有独立开关，停用/卸载 `dsh-liubian-twin` 即停用孪生，
 * 记忆注入（dsh-liubian）不受影响。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_NAME = 'dsh-liubian-twin'
export const PLUGIN_VERSION = '0.1.0'

/**
 * `defineTool` 来自宿主的 @deepseek-ai/dsh-tools（插件 node_modules 里的 junction 指到
 * profile）。桩测或独立运行环境下可能解析不到 —— 那时退回最小替身，
 * 让本模块仍可被导入做纯函数测试；真正的 schema 投影只有宿主在乎。
 */
let defineTool = def => def
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch {
  /* 保持替身 */
}

/* ──────────────────────────────────────────────────────────────────────────
 * 1. 路径与配置
 * ────────────────────────────────────────────────────────────────────────── */

const HOME = process.env.USERPROFILE || process.env.HOME || homedir()
export const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
export const TWIN_DIR = join(DSH_HOME, 'liubian-twin')

export function configFile() {
  return join(TWIN_DIR, 'config.json')
}
export function sessionDir() {
  return join(TWIN_DIR, 'sessions')
}
export function sessionFile(sessionId) {
  return join(sessionDir(), `${String(sessionId).replace(/[^\w.-]/g, '_')}.jsonl`)
}
export function userCriteriaFile() {
  return join(TWIN_DIR, 'criteria.json')
}
export function bundledCriteriaFile() {
  return fileURLToPath(new URL('../criteria.json', import.meta.url))
}

/** 全部默认值。**没有开关项**（孪生随本插件启用/停用）。 */
export const DEFAULTS = {
  twinChainHeadAlways: true,
  twinGapCalls: 10,
  twinGapMinutes: 10,
  twinCriteria: '',
  twinPrompt: '',
  twinMaxReviewsPerTurn: 12,
  twinTimeoutMs: 30000,
  twinRetryDelayMs: 5000,
  twinRetryMax: 5,
  twinUnavailableText: '监察api不可用，请尝试关闭插件或者稍后尝试',
}

function readJsonIfExists(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 默认值 ← 配置文件 ← 宿主传入的 config，逐层覆盖。 */
export function loadConfig(input = {}) {
  const file = readJsonIfExists(configFile())
  return { ...DEFAULTS, ...(file && typeof file === 'object' ? file : {}), ...(input && typeof input === 'object' ? input : {}) }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 2. 判据（插件独属的 criteria.json，不装载任何技能文件）
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 判据来源优先级：配置里显式给的路径 → 用户覆盖 `~/.dsh/liubian-twin/criteria.json`
 * → 插件自带那份（版本受控、随插件走）。
 */
export function loadCriteria(cfg) {
  const explicit = String(cfg.twinCriteria || '').trim()
  const user = userCriteriaFile()
  const path = explicit && existsSync(explicit) ? explicit : existsSync(user) ? user : bundledCriteriaFile()
  const doc = readJsonIfExists(path)
  if (!doc || !Array.isArray(doc.items) || doc.items.length === 0) {
    return { path, ok: false, doc: null, error: `判据文件不可用：${path}` }
  }
  return { path, ok: true, doc }
}

export const CONTRACT = '只输出 JSON：{"conform":bool,"reason":"…","correction":"…"}'

/**
 * 拼送监指令。顺序：角色与硬要求 → 用法 → 判据（一条一行）→ 输出契约 → 指认待审对象。
 * 判据不写来源、不用比喻、不用行话（用户指定：这是给审查智能体看的，不是施工文档）。
 */
export function buildInstruction(criteria, targetDesc, meta = {}) {
  const items = (criteria.items || [])
    .map(it => `[场景] ${String(it.when || '').trim()} → 要求 ${String(it.q || '').trim()}`)
    .join('\n')
  const where = meta.turn != null && meta.step != null ? `（本回合 turn ${meta.turn} / step ${meta.step}）` : ''
  return [
    String(criteria.role || '').trim(),
    String(criteria.usage || '').trim(),
    items,
    String(criteria.contract || CONTRACT).trim(),
    '',
    `本次待审对象${where}：`,
    targetDesc,
    '用户原始指令见上文最后一条用户消息（本插件注入的块不算用户指令）。',
  ]
    .filter(line => line !== '')
    .join('\n')
}

/** 待审对象的人话描述。 */
export function describeTarget(kind, payload = {}) {
  if (kind === 'tool') {
    let args = payload.argumentsText
    if (typeof args !== 'string') {
      try {
        args = JSON.stringify(payload.arguments)
      } catch {
        args = String(payload.arguments)
      }
    }
    if (args && args.length > 4000) args = `${args.slice(0, 4000)}…（参数过长已截断）`
    return `执行智能体要调用工具：${payload.name}\n参数：${args}`
  }
  const text = String(payload.text || '')
  return `执行智能体准备输出的话：\n${text.length > 6000 ? `${text.slice(0, 6000)}…（过长已截断）` : text}`
}

/* ──────────────────────────────────────────────────────────────────────────
 * 3. 裁决解析（宽松：剥代码块围栏、取第一个平衡的 JSON 对象）
 * ────────────────────────────────────────────────────────────────────────── */

export function parseVerdict(text) {
  const raw = String(text || '')
  if (!raw.trim()) return { ok: false, error: '空回复' }
  const candidates = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1])
  const start = raw.indexOf('{')
  if (start >= 0) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          candidates.push(raw.slice(start, i + 1))
          break
        }
      }
    }
  }
  candidates.push(raw)
  for (const cand of candidates) {
    let obj
    try {
      obj = JSON.parse(cand.trim())
    } catch {
      continue
    }
    if (!obj || typeof obj !== 'object' || typeof obj.conform !== 'boolean') continue
    return {
      ok: true,
      verdict: {
        conform: obj.conform,
        reason: typeof obj.reason === 'string' ? obj.reason : '',
        correction: typeof obj.correction === 'string' ? obj.correction : '',
      },
    }
  }
  return { ok: false, error: `裁决不是预期 JSON：${raw.slice(0, 200)}` }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 4. per-session 状态与闸门触发规则
 * ────────────────────────────────────────────────────────────────────────── */

const states = new Map()

export function makeState() {
  return {
    actionSeq: 0, // 动作序号（每个工具调用 / 每次文本输出 +1）
    lastReviewSeq: -1, // 上一次审查发生在哪个动作序号
    lastReviewAt: 0, // 上一次审查的时间戳
    prevKind: null, // 上一个动作的类型（tool / text）
    budget: 0, // 本回合已用审查次数
    turnKey: null, // 回合标识（变了就重置预算）
    corrections: 0, // 本回合提过几次意见
    unresolved: false, // 未解决出口：提两次后停止继续审
    turn: null,
    step: null,
    reviewing: false,
  }
}

export function stateFor(sessionId) {
  let st = states.get(sessionId)
  if (!st) {
    st = makeState()
    states.set(sessionId, st)
  }
  return st
}

export function dropState(sessionId) {
  states.delete(sessionId)
}

/**
 * 闸门触发规则（用户定义，已用 8 个真实会话实测模拟）：
 *   ① 该动作前面不是同类动作（链首 / 本回合首次输出）→ 必审；
 *   ② 前面是同类动作 → 距上一次审查 ≥ twinGapCalls 次 或 ≥ twinGapMinutes 分钟 → 审；
 *   ③ 两者都不满足 → 跳过。
 * 另外：预算用尽 / 未解决出口 → 静默跳过（不审查、不报错）。
 */
export function evaluateGate(st, cfg, kind, now, actionSeq, prevKind) {
  if (st.unresolved) return { review: false, why: 'unresolved-exit' }
  if (prevKind !== kind && cfg.twinChainHeadAlways) return { review: true, why: prevKind === null ? 'chain-head' : 'kind-switch' }
  if (st.budget >= Number(cfg.twinMaxReviewsPerTurn)) return { review: false, why: 'budget' }
  if (actionSeq - st.lastReviewSeq >= Number(cfg.twinGapCalls)) return { review: true, why: 'gap-calls' }
  if (st.lastReviewAt && now - st.lastReviewAt >= Number(cfg.twinGapMinutes) * 60000) return { review: true, why: 'gap-time' }
  return { review: false, why: 'inside-gap' }
}

/**
 * 看一眼这个动作该不该审，**并记账**（推进 actionSeq、更新 prevKind）。
 * 副作用是有意的：钩子进来先判要不要审，顺便把"上一个动作是什么"记下来。
 */
export function shouldReview(st, cfg, kind, now = Date.now()) {
  const decision = evaluateGate(st, cfg, kind, now, st.actionSeq + 1, st.prevKind)
  st.actionSeq += 1
  st.prevKind = kind
  return decision
}

/**
 * 只看不记账（文本闸门用：要在这步的**第一个分块之前**就知道该不该扣住，
 * 免得先放出去一个 text 块的 block-start，事后又得把它撤回来——那会破坏流的块语法）。
 */
export function peekReview(st, cfg, kind, now = Date.now()) {
  return evaluateGate(st, cfg, kind, now, st.actionSeq + 1, st.prevKind)
}

/** 记一次已发生的审查。 */
export function markReviewed(st, now = Date.now()) {
  st.lastReviewSeq = st.actionSeq
  st.lastReviewAt = now
  st.budget += 1
}

/** 新回合重置预算与未解决标记。 */
export function resetTurn(st, turnKey) {
  if (st.turnKey === turnKey) return
  st.turnKey = turnKey
  st.budget = 0
  st.corrections = 0
  st.unresolved = false
  st.actionSeq = 0
  st.lastReviewSeq = -1
  st.prevKind = null
}

/* ──────────────────────────────────────────────────────────────────────────
 * 5. 监察调用（宿主 llm 服务 + 会话同源消息 + 超时与重试）
 * ────────────────────────────────────────────────────────────────────────── */

function sleep(ms, signal) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

/**
 * 消息构造：手搓等形结构（id 是硬性要求，缺了会写坏会话日志；`form:'notice'` 必须带 summary）。
 * 合法 form：undefined / instructions / catalog / snapshot / notice / relay / recall。
 */
function userMessage(text, form, summary) {
  const source = { kind: 'plugin', plugin: PLUGIN_NAME }
  if (form === 'notice') source.form = 'notice', source.summary = summary || text
  else if (form) source.form = form
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source }
}

function assistantRecordMessage(content, provider, model) {
  return {
    id: randomUUID(),
    role: 'assistant',
    content,
    source: { kind: 'model', provider, model },
  }
}

/**
 * 一次监察调用：取会话同源消息（`deriveMessages()`）+ 末尾追加一条监察指令，
 * 用**会话自己的** provider/model，不带 tools（监察只回 JSON）。
 * 失败（传输错 / 超时 / 裁决解析不出来）→ 每 twinRetryDelayMs 重试一次，共 twinRetryMax 次。
 *
 * @returns {{status:'conform'|'deny'|'unavailable'|'skipped', verdict?:object, thinking:string, provider?:string, model?:string, error?:string}}
 */
export async function callTwin(ctx, cfg, agent, { instruction, signal, log }) {
  const session = agent?.session
  if (!session) return { status: 'skipped', thinking: '', error: 'agent 没有 session' }
  const ctxInfo = session.requestContext?.()
  if (!ctxInfo || !ctxInfo.provider || !ctxInfo.model) {
    return { status: 'skipped', thinking: '', error: '会话还没有 requestContext（provider/model 未知）' }
  }
  const criteria = loadCriteria(cfg)
  if (!criteria.ok) return { status: 'skipped', thinking: '', error: criteria.error }

  let messages
  try {
    messages = [...session.deriveMessages(), userMessage(instruction, 'instructions')]
  } catch (err) {
    return { status: 'skipped', thinking: '', error: `deriveMessages 失败：${err?.message || err}` }
  }

  const attempts = Math.max(1, Number(cfg.twinRetryMax) || 1)
  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) return { status: 'skipped', thinking: '', error: '已中止' }
    const ac = new AbortController()
    const onAbort = () => ac.abort(signal?.reason)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ac.abort(new Error('twin timeout')), Math.max(1000, Number(cfg.twinTimeoutMs) || 30000))
    let text = ''
    let thinking = ''
    try {
      const stream = ctx.llm.stream({
        provider: ctxInfo.provider,
        model: ctxInfo.model,
        messages,
        signal: ac.signal,
      })
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') thinking += chunk.text
      }
      const parsed = parseVerdict(text)
      if (parsed.ok) {
        return { status: parsed.verdict.conform ? 'conform' : 'deny', verdict: parsed.verdict, thinking, provider: ctxInfo.provider, model: ctxInfo.model }
      }
      lastError = parsed.error
    } catch (err) {
      lastError = (err && err.message) || String(err)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    if (attempt < attempts) {
      log?.warn?.(`[${PLUGIN_NAME}] 监察调用失败（第 ${attempt}/${attempts} 次）：${lastError}；${cfg.twinRetryDelayMs}ms 后重试`)
      await sleep(Math.max(0, Number(cfg.twinRetryDelayMs) || 5000), signal)
    }
  }
  log?.warn?.(`[${PLUGIN_NAME}] 监察不可用（已重试 ${attempts} 次）：${lastError}`)
  return { status: 'unavailable', thinking: '', error: lastError }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 6. 落盘：监察思考进会话（原生渲染）+ 一份 jsonl 备份
 * ────────────────────────────────────────────────────────────────────────── */

export function appendTwinRecord(agent, st, res, { kind, log }) {
  const verdict = res.verdict || { conform: false, reason: '', correction: '' }
  const head = verdict.conform ? '通过' : '纠正'
  const body = verdict.conform ? verdict.reason || '未发现偏离' : verdict.correction || verdict.reason || ''
  const text = `〔监察〕${head}：${body}`
  const content = []
  if (res.thinking) content.push({ type: 'reasoning', text: res.thinking })
  content.push({ type: 'text', text })

  const session = agent?.session
  const sessionId = session?.id
  if (session && st.turn != null && st.step != null) {
    try {
      session.append(
        'assistant/message',
        { turn: st.turn, step: st.step, message: assistantRecordMessage(content, res.provider, res.model), stream: [] },
        { surfaceOp: 'append' },
      )
    } catch (err) {
      log?.warn?.(`[${PLUGIN_NAME}] 监察记录追加失败（不影响裁决）：${err?.message || err}`)
    }
  } else {
    log?.debug?.(`[${PLUGIN_NAME}] 监察记录跳过（没有打开的 step）`)
  }
  try {
    mkdirSync(sessionDir(), { recursive: true })
    appendFileSync(
      sessionFile(sessionId || 'unknown'),
      `${JSON.stringify({ time: Date.now(), kind, provider: res.provider, model: res.model, verdict, thinking: res.thinking || '' })}\n`,
      'utf8',
    )
  } catch {
    /* 备份失败不影响主流程 */
  }
  return text
}

/** 把纠正注入给执行侧（user 角色插件消息；比"自己说过的话"更有效）。 */
export function injectCorrection(agent, res, log) {
  const verdict = res.verdict || {}
  const text = `＜孪生监察·纠正＞\n${verdict.correction || verdict.reason || '这一步偏离了用户指令，请改道。'}`
  try {
    agent.inject(userMessage(text, 'instructions'))
  } catch (err) {
    log?.warn?.(`[${PLUGIN_NAME}] 纠正注入失败：${err?.message || err}`)
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 7. 工具闸门：tools/pre-execute
 * ────────────────────────────────────────────────────────────────────────── */

export const NOTE_TOOL = '_twin_note'

/** 自己发起的调用（监察调用自身 / 内部工具）不进闸门，否则会自我递归。 */
let twinDepth = 0
export function twinBusy() {
  return twinDepth > 0
}
function skipExec(exec) {
  if (twinBusy()) return true
  if (!exec || !exec.agent) return true
  if (exec.name === NOTE_TOOL) return true
  return false
}

/**
 * 工具闸门处理器。做成独立函数是为了能桩测"喂假 deny → 工具不执行"这条链。
 *
 * @returns PreToolDecision（allow/deny）
 */
export async function handleToolGate(ctx, cfg, exec, next, log) {
  try {
    if (skipExec(exec)) return next()
    const st = stateFor(exec.agent.session.id)
    const decision = shouldReview(st, cfg, 'tool', Date.now())
    if (!decision.review) return next()

    const criteria = loadCriteria(cfg)
    if (!criteria.ok) {
      log?.warn?.(`[${PLUGIN_NAME}] 工具闸门跳过审查：${criteria.error}`)
      return next()
    }
    const instruction = buildInstruction(criteria.doc, describeTarget('tool', { name: exec.name, arguments: exec.arguments }), {
      turn: st.turn,
      step: st.step,
    })
    markReviewed(st)
    let res
    twinDepth += 1
    try {
      res = await callTwin(ctx, cfg, exec.agent, { instruction, signal: exec.signal, log })
    } finally {
      twinDepth -= 1
    }

    if (res.status === 'skipped') {
      log?.debug?.(`[${PLUGIN_NAME}] 工具闸门跳过审查：${res.error}`)
      return next()
    }
    if (res.status === 'unavailable') {
      // 工具闸门 fail-closed：宁可停住，也不放行一个不可逆的重操作。
      log?.warn?.(`[${PLUGIN_NAME}] 监察不可用 → 送 notice 并中断回合`)
      notifyUnavailable(exec.agent, cfg, log)
      try {
        exec.agent.cancel(new Error(String(cfg.twinUnavailableText)), { keepInbox: true })
      } catch (err) {
        log?.warn?.(`[${PLUGIN_NAME}] 中断回合失败：${err?.message || err}`)
      }
      return { kind: 'deny', reason: String(cfg.twinUnavailableText) }
    }

    appendTwinRecord(exec.agent, st, res, { kind: 'tool', log })
    if (res.status === 'conform') return next()

    st.corrections += 1
    if (st.corrections >= 2) st.unresolved = true
    injectCorrection(exec.agent, res, log)
    return { kind: 'deny', reason: `[监察] ${res.verdict?.correction || res.verdict?.reason || '这一步偏离了用户指令'}` }
  } catch (err) {
    // 闸门自身异常一律放行 —— 绝不让孪生的 bug 卡住执行侧。
    log?.warn?.(`[${PLUGIN_NAME}] 工具闸门异常（放行）：${err?.message || err}`)
    return next()
  }
}

function notifyUnavailable(agent, cfg, log) {
  const text = String(cfg.twinUnavailableText)
  try {
    agent.session.append(
      'user/message',
      userMessage(text, 'notice', text),
      { surfaceOp: 'append' },
    )
  } catch (err) {
    log?.warn?.(`[${PLUGIN_NAME}] 固定文本落盘失败：${err?.message || err}`)
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 8. 文本闸门：包裹 llm/stream，把该步文本扣住到审查结束
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 文本块判定：只有 `text` 块的三种分块会被扣住。
 * ⚠️ `block-end` 必须一起扣 —— 它自带拼好的整块文本，放它过去等于放原文。
 */
function isTextChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return true
  if (chunk.type === 'block-start' && chunk.blockType === 'text') return true
  if (chunk.type === 'block-end' && chunk.block?.type === 'text') return true
  return false
}

/** 合成 `_twin_note` 工具调用的三个分块（宿主会校验块语法：start → delta → end）。 */
export function noteCallChunks(index, id, args) {
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name: NOTE_TOOL, argumentsDelta: json },
    { type: 'block-end', index, block: { type: 'tool-call', id, name: NOTE_TOOL, arguments: json } },
  ]
}

/** 合成一个额外文本块（监察故障时把固定申明落在 finish 之前）。 */
export function noteTextChunks(index, text) {
  return [
    { type: 'block-start', index, blockType: 'text' },
    { type: 'text-delta', index, text },
    { type: 'block-end', index, block: { type: 'text', text } },
  ]
}

/** 取一个不与上游冲突的块序号（上游用 0..N 的小整数，这里从高位取）。 */
let synthIndex = 900
function nextSynthIndex() {
  synthIndex += 1
  if (synthIndex > 999) synthIndex = 901
  return synthIndex
}

/**
 * 文本闸门的流包装器。**契约**（桩测逐条断言）：
 *   - 通过 → 扣住的分块按原顺序放行，`finish` 最后；
 *   - 不通过 → 原文一个字节都不出现，改合成 `_twin_note` 工具调用；
 *   - 监察不可用 → 原样放行 + 末尾补一句固定申明（fail-open）；
 *   - 中止（signal）→ 立刻释放已扣住的分块，绝不吊死流；
 *   - 上游异常 → 先把扣住的分块放回去再抛（绝不吞掉模型输出）；
 *   - 纯工具调用步（整步没有正文）不审文本，交给工具闸门。
 *
 * 为什么要**从头扣**：流有块语法（`block-start` → delta → `block-end`，宿主
 * `dsh-llm` 的 validateStream 逐块校验）。文本块的 `block-start` 先于第一个
 * `text-delta` 到达，若那时才决定扣，就已经把一个块开出去、事后无法体面地撤回
 * （veto 后会留下一个未关闭的块，宿主直接判流非法）。所以先用 peekReview 只看
 * 不记账地判一次：要审就从第一个分块起全扣，且**只有真的出现了正文**才记账。
 */
export async function* textGate({ cfg, st, upstream, review, signal, log, unavailableText }) {
  const held = []
  let buffering = false
  let committed = false
  let sawToolCall = false
  let aborted = false
  let finishChunk = null
  let error = null

  const flushHeld = function* () {
    if (!held.length) return
    const chunks = held.splice(0, held.length)
    yield* chunks
  }

  if (peekReview(st, cfg, 'text').review) buffering = true

  try {
    for await (const chunk of upstream) {
      if (chunk?.type === 'finish') {
        finishChunk = chunk
        break
      }
      if (signal?.aborted && !aborted) {
        aborted = true
        if (buffering) {
          yield* flushHeld()
          buffering = false
        }
      }
      if (chunk?.type === 'text-delta' && !committed) {
        committed = true
        // 到这一刻才算"这一步确实输出了正文"，把账记上（与决策同源，结果一致）。
        const decision = shouldReview(st, cfg, 'text')
        buffering = decision.review
        if (!buffering) log?.debug?.(`[${PLUGIN_NAME}] 文本不审（${decision.why}）`)
      }
      if (buffering) {
        held.push(chunk)
        if (chunk?.type === 'tool-call-delta') {
          // 这一步要调工具：正文立刻放行，那一调用由工具闸门审。
          sawToolCall = true
          yield* flushHeld()
          buffering = false
        }
        continue
      }
      yield chunk
    }
  } catch (err) {
    error = err
  }

  if (error) {
    yield* flushHeld()
    throw error
  }

  const text = held
    .filter(c => c.type === 'text-delta')
    .map(c => c.text)
    .join('')

  if (buffering && !aborted && !sawToolCall && text.trim() !== '') {
    let res = null
    try {
      res = await review({ kind: 'text', text })
    } catch (err) {
      res = { status: 'unavailable', error: (err && err.message) || String(err) }
    }
    if (res && res.status === 'deny') {
      // 原文整块丢弃（含它的 block-start / block-end，保证不留下未关闭的块）。
      const kept = held.filter(c => !isTextChunk(c))
      held.length = 0
      for (const c of kept) yield c
      for (const c of noteCallChunks(nextSynthIndex(), `call-twin-${randomUUID()}`, {
        reason: res.verdict?.reason || '',
        correction: res.verdict?.correction || res.verdict?.reason || '',
      })) {
        yield c
      }
    } else if (res && res.status === 'unavailable') {
      yield* flushHeld()
      for (const c of noteTextChunks(nextSynthIndex(), `\n\n〔孪生监察〕${String(unavailableText || '')}`)) yield c
    }
  }

  yield* flushHeld()
  if (finishChunk) yield finishChunk
}

/* ──────────────────────────────────────────────────────────────────────────
 * 9. apply：接线
 * ────────────────────────────────────────────────────────────────────────── */

export function apply(ctx, input = {}) {
  const cfg = loadConfig(input)
  const log = ctx.logger

  ctx.effect(() => {
    // 内部工具：文本闸门被拒时，模型收到的"工具结果"就是它的返回值。
    return ctx.tools.register(
      defineTool({
        name: NOTE_TOOL,
        description: '孪生监察的内部通道（由监察自动发起，不是给模型主动调用的工具）。',
        parameters: {
          reason: { type: 'string', description: '监察给出的理由' },
          correction: { type: 'string', description: '监察要求改成什么' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute(args) {
          const reason = String(args?.reason || '').trim()
          const correction = String(args?.correction || '').trim()
          return [
            '＜孪生监察：这一步未通过审查，你刚才准备输出的内容已被拦下＞',
            correction ? `要求改成：${correction}` : '要求改道后再输出。',
            reason ? `理由：${reason}` : '',
            '请按上面的要求重新组织这一步（不要辩解，直接改）。',
          ]
            .filter(Boolean)
            .join('\n')
        },
      }),
    )
  }, `${PLUGIN_NAME}.note-tool`)

  // 回合/步账本：只拿得到 session 与事件，就从事件流里记账（append 必须落在打开的 step 内）。
  ctx.on('session/event', (session, event) => {
    if (!session || !event) return
    if (event.type === 'turn/start') {
      const st = stateFor(session.id)
      resetTurn(st, event.data?.turn)
      st.turn = event.data?.turn ?? null
      st.step = null
    } else if (event.type === 'step/start') {
      const st = stateFor(session.id)
      st.turn = event.data?.turn ?? st.turn
      st.step = event.data?.step ?? null
    } else if (event.type === 'step/end') {
      const st = stateFor(session.id)
      st.step = null
    }
  })

  ctx.on('session/disposed', session => {
    if (session?.id) dropState(session.id)
  })

  // 工具闸门：prepend —— 越早裁决越好，别让别的监听器先把动作放出去。
  ctx.on(
    'tools/pre-execute',
    (exec, next) => handleToolGate(ctx, cfg, exec, next, log),
    { prepend: true },
  )

  // 文本闸门：包裹流。不带 sessionId 的调用（监察自己）直接放行。
  ctx.on('llm/stream', (options, next) => {
    try {
      if (twinBusy()) return next()
      if (!options || options.sessionId === undefined) return next()
      if (options.purpose) return next() // session-title / compaction 之类的内部调用不审
      const agent = ctx.agents?.get?.(options.sessionId)
      if (!agent) return next()
      const st = stateFor(options.sessionId)
      const upstream = next()
      return textGate({
        cfg,
        st,
        upstream,
        signal: options.signal,
        log,
        unavailableText: cfg.twinUnavailableText,
        review: async ({ kind, text }) => {
          const criteria = loadCriteria(cfg)
          if (!criteria.ok) return { status: 'skipped', error: criteria.error }
          const instruction = buildInstruction(criteria.doc, describeTarget(kind, { text }), { turn: st.turn, step: st.step })
          markReviewed(st)
          let res
          twinDepth += 1
          try {
            res = await callTwin(ctx, cfg, agent, { instruction, signal: options.signal, log })
          } finally {
            twinDepth -= 1
          }
          if (res.status === 'deny') {
            st.corrections += 1
            if (st.corrections >= 2) st.unresolved = true
            appendTwinRecord(agent, st, res, { kind: 'text', log })
          } else if (res.status === 'conform') {
            appendTwinRecord(agent, st, res, { kind: 'text', log })
          }
          return res
        },
      })
    } catch (err) {
      log?.warn?.(`[${PLUGIN_NAME}] 文本闸门接线异常（放行）：${err?.message || err}`)
      return next()
    }
  })

  const criteria = loadCriteria(cfg)
  ctx.logger?.info?.(
    `[${PLUGIN_NAME}] v${PLUGIN_VERSION} 已挂载：判据=${criteria.ok ? criteria.path : `不可用(${criteria.error})`} `
      + `条目=${criteria.ok ? criteria.doc.items.length : 0} 间隔=${cfg.twinGapCalls}次/${cfg.twinGapMinutes}分 `
      + `预算=${cfg.twinMaxReviewsPerTurn} 重试=${cfg.twinRetryMax}×${cfg.twinRetryDelayMs}ms（无独立开关；停用本插件即停用孪生）`,
  )
}

/* ──────────────────────────────────────────────────────────────────────────
 * 10. 桩测入口（不依赖真模型；dev_stage / node 直接调用）
 * ────────────────────────────────────────────────────────────────────────── */

export const __test = {
  PLUGIN_NAME,
  DEFAULTS,
  loadConfig,
  loadCriteria,
  buildInstruction,
  describeTarget,
  parseVerdict,
  makeState,
  stateFor,
  shouldReview,
  peekReview,
  evaluateGate,
  markReviewed,
  resetTurn,
  textGate,
  noteCallChunks,
  noteTextChunks,
  isTextChunk,
  handleToolGate,
  userMessage,
}
