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
 * 两条用血换来的纪律（2026-09-18 实测事故，详见各自函数上的注释）：
 *   ① 送监请求必须补占位工具结果 —— 工具闸门被调用时，会话尾巴是一条"只有 tool_calls、
 *      没有 tool 结果"的消息，直接送上游必被拒收（表现为"空回复"，5 次重试全废）；
 *   ② 绝不在工具窗口里写会话 —— 在 assistant(tool_calls) 与它的工具结果之间插任何消息，
 *      会让这条会话从此每个回合都 400 报错、彻底读不出来。所有写入排队到 step/end 再落。
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
  twinIdleTimeoutMs: 5000, // 两次输出之间的空档超过这么久才算超时（不掐思考耗时）
  twinTimeoutMs: 300000, // 单次审查的绝对上限（兜底，正常不会碰到）
  // 结构伪造（用户指定，默认开）：在监察指令**后面**再追加一条"助手消息"。
  // 上游模板把助手消息渲染成 `{reasoning}</think>{content}{tool_calls}<｜end▁of▁sentence｜>`，
  // 所以这条伪造消息等于递给模型一个"思考已结束、话已说完"的助手回合，
  // 把生成位从"续写执行侧的对话"挪到"直接给这份结论"。它只随请求发出去，绝不写进会话。
  twinForge: true,
  twinForgeReasoning: '（判据已逐条对照完毕，下面直接给结论。）',
  twinForgeContent: '',
  // 上下文模式：'isolated'（默认）只带"最近一段进展 + 监察指令"，不带执行侧整段历史；
  // 'full' 是原设计（整段对话原样带上）。实测 full 下模型会把自己当执行侧，续写、吐工具调用。
  twinContextMode: 'isolated',
  twinBackgroundChars: 1500, // 隔离模式下给监察的背景字数上限；0 = 连背景都不给
  // 纯文本尾巴（老做法残留开关，默认关）：实测会把模型带偏去分析那串标记本身，留着备用。
  twinPrefill: '',
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

export const CONTRACT = [
  '先写结论，再写理由。结论只写一个词：',
  '・没有偏离：第一行写「通过」，第二行起写一句理由；',
  '・有偏离：第一行写「纠正」，第二行起写清哪里偏离、你看到的证据、下一步要改成什么。',
  '用普通话写成一段话就行，不必写成 JSON，也不必调用工具。',
].join('\n')

/** 取一条消息里的正文（text 块拼接）。 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
}

/**
 * 找出**用户本人的原始指令**。
 *
 * 为什么要专门找：监察请求 = `[...deriveMessages(), 监察指令]`，也就是说
 * **最后一条 user 消息就是本条监察指令自己**；再加上流变那几块注入（接入卡 / 教训 / 能力卡 /
 * 逐轮提醒）也都是 user 角色的插件消息，光说"见上文最后一条用户消息"必然指错
 * （实测第一版冒烟就指到了监察指令本身）。
 * 所以这里把真正的用户原话找出来（`source.kind === 'user'` 的最后一条），直接引到指令里。
 */
export function lastUserInstruction(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'user') continue
    if (msg.source?.kind !== 'user') continue
    const text = messageText(msg)
    if (text.trim()) return text.length > 6000 ? `${text.slice(0, 6000)}…（过长已截断）` : text
  }
  return ''
}

/**
 * 拼送监指令。顺序：角色与硬要求 → 用法 → 判据（一条一行）→ 输出契约 → 指认待审对象 → 用户原话。
 */
export function buildInstruction(criteria, targetDesc, meta = {}) {
  const items = (criteria.items || [])
    // 条目的 q 本身就以"要求…"开头，这里不再重复加"要求"，免得渲染成"要求 要求…"
    .map(it => `[场景] ${String(it.when || '').trim()} → ${String(it.q || '').trim()}`)
    .join('\n')
  const where = meta.turn != null && meta.step != null ? `（本回合 turn ${meta.turn} / step ${meta.step}）` : ''
  const head = [
    String(criteria.role || '').trim(),
    String(criteria.usage || '').trim(),
    items,
    String(criteria.contract || CONTRACT).trim(),
  ]
  const tail = [
    `本次待审对象${where}：`,
    targetDesc,
    '用户本人的原始指令（**只按这一段为准**；上面若还有别的 user 角色消息，那是系统或插件注入的块，不算用户指令；本条监察指令也不算）：',
    meta.userInstruction ? `«${meta.userInstruction}»` : '（未能在上下文里定位到用户原话，请以你看到的上文为准）',
  ]
  // 伪造的尾巴（用户指定）：把"思考结束"这个阶段状态直接写出来，逼它进入作答，
  // 而不是花一整轮进入监察角色、续写执行侧对话、或吐工具调用标记。
  const prefill = String(meta.prefill ?? '').trim()
  return [...head, '', ...tail, ...(prefill ? ['', prefill] : [])].filter(line => line !== '').join('\n')
}

/**
 * 隔离模式下给监察的"背景"：只取执行侧**最近一条**助手消息里的正文与思考，按字数截断。
 * 目的不是让它读懂全案，而是让它知道"这个人现在手上在做哪一步"；不给整段历史，
 * 就没有可续写的执行侧身份。`twinBackgroundChars: 0` 表示连这段也不给。
 */
export function backgroundMessages(base, cfg) {
  const limit = Number(cfg.twinBackgroundChars ?? 1500)
  if (!limit || limit <= 0) return []
  for (let i = base.length - 1; i >= 0; i--) {
    const msg = base[i]
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue
    const text = msg.content.filter(b => b?.type === 'text').map(b => b.text).join('')
    const thinking = msg.content.filter(b => b?.type === 'reasoning').map(b => b.text).join('')
    const parts = []
    if (thinking) parts.push(`【它刚才的思考】\n${thinking}`)
    if (text) parts.push(`【它刚才说的话】\n${text}`)
    if (!parts.length) continue
    let body = parts.join('\n')
    if (body.length > limit) body = `${body.slice(-limit)}`
    return [userMessage(`下面这段是执行智能体最近的进展（节选，可能有截断）：\n\n${body}`, 'instructions')]
  }
  return []
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
 * 3. 裁决解析
 *
 * **不强制监察输出 JSON**（用户指定）：默认形态是普通话的一段话，
 * 靠"第一行的结论词"认裁决 —— 第一行只写「通过」或「纠正」。
 * 解析按下面的顺序走，尽量宽容：
 *   ① 真的给了 JSON（含 conform 布尔）→ 直接认，兼容老写法；
 *   ② 第一行（短行才算结论行）里的结论词；
 *   ③ 开头 200 字里的结论词；
 *   ④ 全文里的结论词。
 * 认词顺序固定为「否定式的正结论 → 负面词 → 正面词」，
 * 否则「没有偏离」会被「偏离」抢先误判成偏离。
 * 认不出结论词才算失败（会重试），一律不复述模型的话当裁决。
 * ────────────────────────────────────────────────────────────────────────── */

const CONFORM_PHRASES = ['无偏离', '没有偏离', '不存在偏离', '未发现偏离', '无需纠正', '无需修改', '没问题', '可以继续', '无需改动']
const DENY_PHRASES = ['纠正', '未通过', '不通过', '不符合', '不一致', '有问题', '存在偏离', '有偏离', '偏离', '需要修改', '需要改', '应当改', '越权', '超出交办']
const CONFORM_WORDS = ['通过', '符合', '一致', '同意']

/** 去掉 Markdown 装饰与标点，只留字，方便认结论词。 */
function stripDecoration(line) {
  return String(line || '')
    .replace(/[#*`>_\s]/g, '')
    .replace(/[【】\[\]〔〕（）()「」『』《》:：,，。、.!！?？~～—－-]/g, '')
    .trim()
}

/** 一行里有没有结论词。返回 'conform' | 'deny' | ''。 */
export function markerOf(line) {
  const s = stripDecoration(line)
  if (!s) return ''
  for (const p of CONFORM_PHRASES) if (s.includes(p)) return 'conform'
  for (const p of DENY_PHRASES) if (s.includes(p)) return 'deny'
  for (const p of CONFORM_WORDS) if (s.includes(p)) return 'conform'
  return ''
}

/** 老写法（模型自愿给 JSON）照样认。 */
function verdictFromJson(raw) {
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
  return null
}

export function parseVerdict(text) {
  const raw = String(text || '').trim()
  if (!raw) return { ok: false, error: '空回复' }

  const asJson = verdictFromJson(raw)
  if (asJson) return asJson

  const lines = raw.split(/\r?\n/)
  let head = 0
  while (head < lines.length && !lines[head].trim()) head += 1
  const firstLine = (lines[head] || '').trim()

  let marker = ''
  let body = ''
  if (firstLine.length <= 30) {
    marker = markerOf(firstLine)
    if (marker) body = lines.slice(head + 1).join('\n').trim()
  }
  if (!marker) marker = markerOf(raw.slice(0, 200))
  if (!marker) marker = markerOf(raw)
  if (!marker) return { ok: false, error: `没找到结论词（通过／纠正）：${raw.slice(0, 160)}` }

  const detail = (body || raw).trim()
  const conform = marker === 'conform'
  return {
    ok: true,
    verdict: {
      conform,
      reason: detail,
      correction: conform ? '' : detail,
    },
  }
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
    twinDown: false, // 本回合监察已判定不可用：不再重试，逐条拒掉，等结果落盘后再中断回合
    pending: [], // 待落盘的写入（监察记录 / 通知 / 中断），只在工具窗口之外 flush
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
  st.twinDown = false
  st.pending = [] // 上一回合没来得及落盘的，宁可丢记录也不写进坏时点
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
 * 结构伪造：造一条"思考已结束"的助手消息，**只贴在监察请求末尾，不写进会话**。
 *
 * 依据（从官方 encoder 抄的模板）：助手消息渲染成
 *   `{reasoning_content}</think>{content}{tool_calls}<｜end▁of▁sentence｜>`
 * 也就是说，只要我们递一条助手消息过去，上游就会把它当成"上一个助手回合已经说完"，
 * 生成位因此落在它后面 —— 模型不会再接着执行侧那条工具调用往下做，而是直接给这份结论。
 * 不伪造时，请求末尾永远是"最后一条 user 消息 + 服务端补的思考开始标记"，
 * 模型于是先想一大段、再续写执行侧的活（实测三类失败都由此而来）。
 *
 * 改成别的写法只要动配置：`twinForgeReasoning` / `twinForgeContent` / `twinForge: false`。
 */
export function forgedAssistantMessage(cfg, provider, model) {
  const content = []
  const reasoning = String(cfg.twinForgeReasoning ?? '').trim()
  const text = String(cfg.twinForgeContent ?? '')
  if (reasoning) content.push({ type: 'reasoning', text: reasoning })
  if (text) content.push({ type: 'text', text })
  if (!content.length) content.push({ type: 'text', text: '' })
  return assistantRecordMessage(content, provider, model)
}

/**
 * 送监消息的**形态修复**（实测踩出来的硬要求，不能省）：
 *
 * 工具闸门是在「assistant 已经带 tool_calls、它的工具结果还没落盘」这个窗口里被调用的，
 * 此刻 `deriveMessages()` 的尾巴正是一条只有 tool_calls、后面没有任何 tool 结果的消息。
 * 线格式要求 assistant 的每个 tool_call_id 后面都必须紧跟对应的 tool 消息，
 * 上游会直接拒收（实测：108ms 就结束、流里一个字节都没有，表现为"空回复"，
 * 于是连重试 5 次全废 —— 工具闸门等于从来没生效过）。
 *
 * 修法：给**尚未执行**的调用补一条占位结果 —— 调用本身留在上下文里（监察要审的正是它），
 * 只是明确写上"尚未执行、没有结果"，不假装它跑过了。
 */
export const PENDING_RESULT_TEXT = '（该调用尚未执行：这一步正在审查，还没有结果）'

export function placeholderToolResult(callId) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [
      { type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: PENDING_RESULT_TEXT }], isError: false },
    ],
    source: { kind: 'tool', callId },
  }
}

/**
 * 给所有"有 tool_calls 但没有对应 tool 结果"的调用补占位结果；已配对的原样不动。
 * 占位结果补在那条 assistant 后面**连续工具结果段**的末尾，保持"调用顺序 → 结果顺序"一致。
 */
export function sanitizeForTwin(messages) {
  const list = Array.isArray(messages) ? messages : []
  const resultIdsOf = msg => (Array.isArray(msg?.content) ? msg.content : [])
    .filter(block => block && block.type === 'tool-result' && block.toolCallId)
    .map(block => block.toolCallId)
  const out = []
  for (let i = 0; i < list.length; i++) {
    const msg = list[i]
    out.push(msg)
    const callIds = (Array.isArray(msg?.content) ? msg.content : [])
      .filter(block => block && block.type === 'tool-call' && block.id)
      .map(block => block.id)
    if (!callIds.length) continue
    const answered = new Set()
    let j = i + 1
    while (j < list.length) {
      const ids = resultIdsOf(list[j])
      if (!ids.length) break
      for (const id of ids) answered.add(id)
      out.push(list[j])
      j += 1
    }
    for (const id of callIds) {
      if (!answered.has(id)) out.push(placeholderToolResult(id))
    }
    i = j - 1 // 这一段工具结果已经搬过了，别重复 push
  }
  return out
}

/**
 * 一次监察调用：取会话同源消息（`deriveMessages()`）+ 末尾追加一条监察指令，
 * 用**会话自己的** provider/model，不带 tools（监察只回 JSON）。
 * 失败（传输错 / 超时 / 裁决解析不出来）→ 每 twinRetryDelayMs 重试一次，共 twinRetryMax 次。
 *
 * @returns {{status:'conform'|'deny'|'unavailable'|'skipped', verdict?:object, thinking:string, provider?:string, model?:string, error?:string}}
 */
export async function callTwin(ctx, cfg, agent, { kind, targetDesc, meta = {}, signal, log }) {
  const session = agent?.session
  if (!session) return { status: 'skipped', thinking: '', error: 'agent 没有 session' }
  const ctxInfo = session.requestContext?.()
  if (!ctxInfo || !ctxInfo.provider || !ctxInfo.model) {
    return { status: 'skipped', thinking: '', error: '会话还没有 requestContext（provider/model 未知）' }
  }
  const criteria = loadCriteria(cfg)
  if (!criteria.ok) return { status: 'skipped', thinking: '', error: criteria.error }

  let base
  try {
    base = sanitizeForTwin(session.deriveMessages())
  } catch (err) {
    return { status: 'skipped', thinking: '', error: `deriveMessages 失败：${err?.message || err}` }
  }
  const instruction = buildInstruction(criteria.doc, targetDesc, { ...meta, userInstruction: lastUserInstruction(base), prefill: cfg.twinPrefill })
  // 上下文模式：
  //   'full'     —— 把执行侧整段对话原样带上（原设计）。实测：模型把自己当执行侧，
  //                 会续写、会吐工具调用标记、偶尔才给结论；末尾再伪造一条助手消息
  //                 反而更糟（它会把那条助手消息当成"接着调工具"的机会）。
  //   'isolated' —— 只带：执行侧最近一段进展（可限长）+ 监察指令，**不带整段历史**。
  //                 这是"结构伪造"的彻底版：整段上下文都是伪造出来的审查现场，
  //                 没有执行侧的身份惯性可续写。
  const isolated = String(cfg.twinContextMode || 'isolated').toLowerCase() !== 'full'
  const messages = isolated
    ? [...backgroundMessages(base, cfg), userMessage(instruction, 'instructions')]
    : [...base, userMessage(instruction, 'instructions')]
  if (cfg.twinForge !== false) messages.push(forgedAssistantMessage(cfg, ctxInfo.provider, ctxInfo.model))
  if (kind === 'debug') return { status: 'skipped', thinking: '', error: '', instruction, messageCount: messages.length }

  const attempts = Math.max(1, Number(cfg.twinRetryMax) || 1)
  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) return { status: 'skipped', thinking: '', error: '已中止' }
    const ac = new AbortController()
    const onAbort = () => ac.abort(signal?.reason)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    // 超时看的是**两次输出之间的空档**，不是整段耗时（用户指定）：
    // 大上下文里模型光想就要 30 秒以上，用"总时长"掐会把正在思考的调用直接切断
    // （实测：23k 字思考、30 秒整被切 → 一个字的正文都没有）。只要还在往外吐字就不算超时。
    const idleMs = Math.max(500, Number(cfg.twinIdleTimeoutMs) || 5000)
    const hardMs = Math.max(idleMs, Number(cfg.twinTimeoutMs) || 300000)
    let watchdog = null
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => ac.abort(new Error(`twin idle ${idleMs}ms`)), idleMs)
    }
    const hardTimer = setTimeout(() => ac.abort(new Error('twin hard timeout')), hardMs)
    armWatchdog()
    let text = ''
    let thinking = ''
    const seenTypes = new Set()
    try {
      const stream = ctx.llm.stream({
        provider: ctxInfo.provider,
        model: ctxInfo.model,
        messages,
        signal: ac.signal,
      })
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        armWatchdog() // 收到任何分块就重新计时
        if (chunk.type) seenTypes.add(chunk.type)
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') thinking += chunk.text
      }
      const parsed = parseVerdict(text)
      if (parsed.ok) {
        return { status: parsed.verdict.conform ? 'conform' : 'deny', verdict: parsed.verdict, thinking, provider: ctxInfo.provider, model: ctxInfo.model }
      }
      // 空回复基本只有一个原因：请求形态被上游拒了，或模型只思考没作答。
      // 把分块类型与思考长度记下来，下次一眼能看出是哪种。
      const types = [...seenTypes].join('/') || '无'
      lastError = parsed.error === '空回复'
        ? (thinking.trim() ? `只思考没有作答（思考 ${thinking.length} 字；分块类型：${types}）` : `空回复（分块类型：${types}）`)
        : `${parsed.error}（分块类型：${types}）`
    } catch (err) {
      lastError = (err && err.message) || String(err)
      if (ac.signal.aborted && /twin (idle|hard)/.test(String(ac.signal.reason?.message || ac.signal.reason || ''))) {
        lastError = `监察流中断（${ac.signal.reason.message}；已收到思考 ${thinking.length} 字、正文 ${text.length} 字）`
      }
    } finally {
      if (watchdog) clearTimeout(watchdog)
      clearTimeout(hardTimer)
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

export function appendTwinRecord(agent, st, res, { kind, log, turn, step } = {}) {
  const verdict = res.verdict || { conform: false, reason: '', correction: '' }
  const head = verdict.conform ? '通过' : '纠正'
  const body = verdict.conform ? verdict.reason || '未发现偏离' : verdict.correction || verdict.reason || ''
  const text = `〔监察〕${head}：${body}`
  const content = []
  if (res.thinking) content.push({ type: 'reasoning', text: res.thinking })
  content.push({ type: 'text', text })

  const session = agent?.session
  const sessionId = session?.id
  const turnNo = turn ?? st.turn
  const stepNo = step ?? st.step
  if (session && turnNo != null && stepNo != null) {
    try {
      session.append(
        'assistant/message',
        { turn: turnNo, step: stepNo, message: assistantRecordMessage(content, res.provider, res.model), stream: [] },
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

/* ── 落盘的时机纪律（本插件最重要的一条纪律）────────────────────────────────
 * **绝不在工具窗口里写会话**：assistant 带上 tool_calls 之后、它的工具结果落盘之前，
 * 往会话里插任何一条消息（哪怕只是给用户看的一行通知），都会让这条会话从此读不出来 ——
 * 实测 2026-09-18：一条 notice 插进中间后，之后每个回合的请求都被上游 400 拒收
 *   "An assistant message with 'tool_calls' must be followed by tool messages responding to
 *    each 'tool_call_id'. (insufficient tool messages following tool_calls message)"
 * 整个对话作废（用户只能弃用那条会话）。
 * 所以所有写入先排队，等这一步的工具结果全部落盘（step/end）再一起落。
 * ────────────────────────────────────────────────────────────────────────── */

/** 记一笔待落盘的监察记录（不在工具窗口里直接写）。turn/step 当场记下，落盘时不再依赖 st。 */
export function queueRecord(st, res, reviewKind) {
  st.pending.push({ kind: 'record', res, reviewKind, turn: st.turn, step: st.step })
}

/** 监察不可用：固定文本 + 中断回合 —— 同样排队，等安全时点再执行。 */
export function queueUnavailable(st, cfg) {
  const text = String(cfg.twinUnavailableText)
  st.pending.push({ kind: 'notice', text })
  st.pending.push({ kind: 'cancel', text })
}

/**
 * 安排一次落盘。**不能在这些同步回调里直接写会话**：
 * 会话正在发布事件，此时 append 会报
 * "cannot reenter while another append is being published"（实测 2026-09-18 23:13:46，
 * 固定文本就是因此没落进会话）。挪到下一个宏任务，仍在下一步的模型请求之前。
 */
function scheduleFlush(ctx, session, st, log) {
  if (!st.pending?.length) return
  const agent = ctx.agents?.get?.(session.id)
  setTimeout(() => flushPending(agent, st, log), 0)
}

/** 把排队的写入落到会话里。**只在工具窗口之外**（step/end、turn/end）调用。 */
export function flushPending(agent, st, log) {
  const items = st.pending || []
  if (!items.length) return []
  st.pending = []
  const session = agent?.session
  const done = []
  for (const item of items) {
    try {
      if (item.kind === 'record') {
        appendTwinRecord(agent, st, item.res, { kind: item.reviewKind, log, turn: item.turn, step: item.step })
        done.push('record')
      } else if (item.kind === 'notice') {
        session.append('user/message', userMessage(item.text, 'notice', item.text), { surfaceOp: 'append' })
        done.push('notice')
      } else if (item.kind === 'cancel') {
        agent.cancel(new Error(item.text), { keepInbox: true })
        done.push('cancel')
      }
    } catch (err) {
      log?.warn?.(`[${PLUGIN_NAME}] 待落盘项失败（${item.kind}，不影响主流程）：${err?.message || err}`)
    }
  }
  return done
}

/** 截断长文本（裁决现在是普通话一段话，可能很长；注入给执行侧要有个上限）。 */
export function clipText(text, max = 1500) {
  const s = String(text || '')
  return s.length > max ? `${s.slice(0, max)}…（过长已截断）` : s
}

/** 把纠正注入给执行侧（user 角色插件消息；比"自己说过的话"更有效）。 */
export function injectCorrection(agent, res, log) {
  const verdict = res.verdict || {}
  const text = `＜孪生监察·纠正＞\n${clipText(verdict.correction || verdict.reason || '这一步偏离了用户指令，请改道。')}`
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
    if (st.twinDown) {
      // 本回合已判定监察不可用：不再重试也不再等，逐条拒掉。
      // 每条拒绝都自带一条工具结果（形态合法），固定文本与中断回合已排队，等本步结果落盘后执行。
      return { kind: 'deny', reason: String(cfg.twinUnavailableText) }
    }
    const decision = shouldReview(st, cfg, 'tool', Date.now())
    if (!decision.review) return next()

    markReviewed(st)
    let res
    twinDepth += 1
    try {
      res = await callTwin(ctx, cfg, exec.agent, {
        kind: 'tool',
        targetDesc: describeTarget('tool', { name: exec.name, arguments: exec.arguments }),
        meta: { turn: st.turn, step: st.step },
        signal: exec.signal,
        log,
      })
    } finally {
      twinDepth -= 1
    }

    if (res.status === 'skipped') {
      log?.debug?.(`[${PLUGIN_NAME}] 工具闸门跳过审查：${res.error}`)
      return next()
    }
    if (res.status === 'unavailable') {
      // 工具闸门 fail-closed：宁可停住，也不放行一个不可逆的重操作。
      // 注意：这里**只返回 deny**，写会话与中断回合都排队到 step/end ——
      // 现在正处在工具窗口里，写任何东西都会毁掉这条会话（见上面那段纪律）。
      log?.warn?.(`[${PLUGIN_NAME}] 监察不可用 → 固定文本 + 中断回合（排队到本步工具结果落盘后执行）`)
      st.twinDown = true
      queueUnavailable(st, cfg)
      return { kind: 'deny', reason: String(cfg.twinUnavailableText) }
    }

    queueRecord(st, res, 'tool')
    if (res.status === 'conform') return next()

    st.corrections += 1
    if (st.corrections >= 2) st.unresolved = true
    injectCorrection(exec.agent, res, log)
    return { kind: 'deny', reason: `[监察] ${clipText(res.verdict?.correction || res.verdict?.reason || '这一步偏离了用户指令', 1500)}` }
  } catch (err) {
    // 闸门自身异常一律放行 —— 绝不让孪生的 bug 卡住执行侧。
    log?.warn?.(`[${PLUGIN_NAME}] 工具闸门异常（放行）：${err?.message || err}`)
    return next()
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
      // 兜底：上一步结束时若没排空，这里也排一次（此刻上一步的结果必然已落盘）。
      scheduleFlush(ctx, session, st, log)
      st.turn = event.data?.turn ?? st.turn
      st.step = event.data?.step ?? null
    } else if (event.type === 'step/end') {
      const st = stateFor(session.id)
      // 这一步的工具结果此刻已经全部落盘 —— 唯一安全的落盘点（见"落盘的时机纪律"）。
      scheduleFlush(ctx, session, st, log)
      st.step = null
    } else if (event.type === 'turn/end') {
      const st = stateFor(session.id)
      scheduleFlush(ctx, session, st, log)
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
          markReviewed(st)
          let res
          twinDepth += 1
          try {
            res = await callTwin(ctx, cfg, agent, {
              kind,
              targetDesc: describeTarget(kind, { text }),
              meta: { turn: st.turn, step: st.step },
              signal: options.signal,
              log,
            })
          } finally {
            twinDepth -= 1
          }
          if (res.status === 'deny') {
            st.corrections += 1
            if (st.corrections >= 2) st.unresolved = true
            queueRecord(st, res, 'text') // 排队落盘：现在还在这一步中间
          } else if (res.status === 'conform') {
            queueRecord(st, res, 'text')
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
  messageText,
  lastUserInstruction,
  parseVerdict,
  markerOf,
  clipText,
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
  sanitizeForTwin,
  placeholderToolResult,
  forgedAssistantMessage,
  queueRecord,
  queueUnavailable,
  flushPending,
  appendTwinRecord,
}
