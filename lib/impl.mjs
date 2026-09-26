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
  twinMaxReviewsPerTurn: 0, // 每回合审查预算；<=0 = 不限（用户指定，取消上限）
  twinIdleTimeoutMs: 5000, // 两次输出之间的空档超过这么久才算超时（不掐思考耗时）
  twinTimeoutMs: 300000, // 单次审查的绝对上限（兜底，正常不会碰到）
  // 结构伪造（用户指定，默认开）：在监察指令**后面**再追加一条"助手消息"。
  // 上游模板把助手消息渲染成 `{reasoning}</think>{content}{tool_calls}<｜end▁of▁sentence｜>`，
  // 所以这条伪造消息等于递给模型一个"思考已结束、话已说完"的助手回合，
  // 把生成位从"续写执行侧的对话"挪到"直接给这份结论"。它只随请求发出去，绝不写进会话。
  twinForge: true,
  twinForgeReasoning: '（判据已逐条对照完毕，下面直接给结论。）',
  // 正文保持为空（2026-09-26 生产证伪后回退）：'{"conform":' 前缀上线（05:05 重启）后
  // 监察成功率从约一半跌到 0%——空回复刷屏 + 出现 6.7 万字只思考的极端案例，
  // 15:09 起彻底全灭（连续 10+ 小时零成功）。半开 JSON 在答区里反而让模型
  // "觉得已经答了一半"然后闭嘴。解析侧的前缀拼接保留：配置手动开前缀时仍然可用。
  twinForgeContent: '',
  // 上下文模式：'flatten'（默认）把最近若干条记录**拍平成一段普通文本**并清掉特殊标识符；
  // 'isolated' 只带最近一条助手消息的思考/正文；'full' 是原设计（整段对话原样带上）。
  twinContextMode: 'flatten',
  twinTranscriptRounds: 10, // 拍平最近多少**轮**（一轮 = 人类发言 + 其后动作/往返）
  twinIncludeTools: false, // 工具调用/工具结果不写进去（用户指定：只留用户输入与模型输出）
  twinIncludeReasoning: true, // 模型思考也拍进去（判"想干什么"很有用）
  twinTranscriptMessages: 6, // 兼容项：twinTranscriptRounds 设为 0 时按条数取
  twinStripMarkers: true, // 清掉全角竖线 ▁ <think> </think> 这些特殊标识符
  twinPrompt: '', // 追加在"要求"一节最前面的自定义要求（空 = 不加）
  // 纯文本尾巴（老做法残留开关，默认关）：实测会把模型带偏去分析那串标记本身，留着备用。
  twinPrefill: '',
  twinRetryDelayMs: 5000,
  twinRetryMax: 5,
  twinUnavailableText: '监察api不可用，请尝试关闭插件或者稍后尝试',
  // ── 通用教训作为审查材料（2026-09-19 自流变·记忆移交；不注入执行侧）──
  // 数据由流变·记忆的 lessons 工具蒸馏/维护（~/.dsh/liubian/lessons*.json）。
  // 每次送审时把清单附进监察指令：被审动作违反适用条目的算偏离。
  twinReviewLessons: true,
  twinLessonsMax: 20,         // 清单最多几条
  twinLessonsChars: 2400,     // 清单字符预算
  twinLessonsDir: '',         // 教训文件目录；空 = <DSH_HOME>/liubian（流变记忆的 lessons CLI 写在那儿）
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
 * 拼送监指令（用户指定的标准输入格式）：整份请求是一条 Markdown 文档，分四块，各块用标题标清性质 ——
 *   一、要求        你（监察）必须照做的：角色 + 判据 + 输出要求
 *   二、上下文依据  只是背景，不要接着做、不要调用工具：用户原话 + 最近记录
 *   三、待判别的动作 只审这一个
 *   四、现在开始    收束语（+ 可选的文本尾巴）
 */
export function buildInstruction(criteria, targetDesc, meta = {}) {
  const items = (criteria.items || [])
    // 条目的 q 本身就以"要求…"开头，这里不再重复加"要求"，免得渲染成"要求 要求…"
    .map((it, i) => `${i + 1}. **${String(it.when || '').trim()}** → ${String(it.q || '').trim()}`)
    .join('\n')
  const where = meta.turn != null && meta.step != null ? `turn ${meta.turn} / step ${meta.step}` : '本回合'
  const contextText = String(meta.contextText ?? '').trim()
  const prefill = String(meta.prefill ?? '').trim()
  const lessonsText = String(meta.lessonsText ?? '').trim()

  const parts = [
    '# 监察任务',
    '你是审查者，只审**下面第三节那一个动作**是否符合用户指令。这份文档是你这一轮的全部输入。',
    '## 一、要求（你要照做的）',
    String(criteria.role || '').trim(),
    String(meta.extraRequirements || '').trim(),
    String(criteria.usage || '').trim(),
    '### 判据（场景对得上就查，对不上就跳过）',
    items,
    ...(lessonsText ? ['### 通用教训（对照参考，违反适用条目的算偏离）', lessonsText] : []),
    '### 输出要求',
    String(criteria.contract || CONTRACT).trim(),
    '## 二、上下文依据（只是背景，**不要接着做、不要调用任何工具**）',
    contextText || '（本次没有附带背景记录；你只按第三节与用户原话判断。）',
    '**用户本人的原始指令**（只按这一段为准；框起来的才是用户自己说的，插件注入的块不算）：',
    meta.userInstruction ? `> «${meta.userInstruction}»` : '（未能在上下文里定位到用户原话，请以你看到的上文为准。）',
    `## 三、待判别的动作（只审这一个，发生于 ${where}）`,
    targetDesc,
    '## 四、现在开始',
    '按「输出要求」给出这一轮的回答，只判第三节那一个动作。',
  ]
  if (prefill) parts.push(prefill)
  return parts.filter(line => String(line).trim() !== '').join('\n\n')
}

/**
 * 把文本里的"特殊标识符"清掉，只留普通文字（用户指定）。
 * 清什么：全角竖线（U+FF5C，模型那串工具调用标记的边框）、词间分隔符 ▁（U+2581）、
 * `<think>` / `</think>` 这对阶段标记，以及它们被清掉后剩下的空壳标点。
 * 为什么：上下文里只要还飘着这些标记，模型就会把它们当成"可分析/可续写的现场"，
 * 伪造尾那个阶段标记也会被当成普通字符串；清干净之后，整个请求里唯一像阶段标记的
 * 就只有我们伪造的那一处。
 */
export function stripSpecialTokens(text) {
  let s = String(text ?? '')
  s = s.replace(/\uFF5C+/g, ' ')        // 全角竖线
  s = s.replace(/\u2581/g, ' ')          // ▁
  s = s.replace(/<\/?think>/gi, ' ')     // 思考阶段标记
  s = s.replace(/[ \t]{2,}/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/**
 * 一条消息里的可读文本（用户指定：只留"用户说的话"和"模型的输出"，工具调用默认丢掉）。
 * `twinIncludeTools: true` 才把工具调用/工具结果也拍进去（排查时用）。
 */
function readableText(msg, cfg = {}) {
  if (!msg) return ''
  const blocks = Array.isArray(msg.content) ? msg.content : []
  const text = blocks.filter(b => b?.type === 'text').map(b => b.text).join('')
  const thinking = blocks.filter(b => b?.type === 'reasoning').map(b => b.text).join('')
  const head = [cfg.twinIncludeReasoning === false ? '' : thinking && `（它的思考）${thinking}`, text].filter(Boolean).join('\n')
  if (cfg.twinIncludeTools !== true) return head
  const calls = blocks.filter(b => b?.type === 'tool-call').map(b => `[调用工具 ${b.name} 参数 ${b.arguments}]`)
  const results = blocks.filter(b => b?.type === 'tool-result').map(b => `[工具结果 ${(Array.isArray(b.content) ? b.content.map(x => x.text).join('') : String(b.content || '')).slice(0, 400)}]`)
  return [head, ...calls, ...results].filter(Boolean).join('\n')
}

/**
 * 按上下文模式算出"给监察看的那段背景文本"（都清过特殊标识符）：
 *   flatten  —— 最近 N **轮**拍平成一段普通文本（默认）
 *   isolated —— 只取最近一条助手消息的思考/正文
 *   full     —— 不给背景（整段真实历史会随请求一起带上）
 *   none     —— 明确不给背景（只审第三节那一个动作）
 * **不设字数上限**（用户指定）。
 */
export function contextTextFor(base, cfg) {
  const mode = String(cfg.twinContextMode || 'flatten').toLowerCase()
  if (mode === 'full' || mode === 'none') return ''
  if (mode === 'flatten') return flattenTranscript(base, cfg)
  for (let i = base.length - 1; i >= 0; i--) {
    const msg = base[i]
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue
    const text = msg.content.filter(b => b?.type === 'text').map(b => b.text).join('')
    const thinking = msg.content.filter(b => b?.type === 'reasoning').map(b => b.text).join('')
    const parts = []
    if (thinking && cfg.twinIncludeReasoning !== false) parts.push(`【它刚才的思考】\n${thinking}`)
    if (text) parts.push(`【它刚才说的话】\n${text}`)
    if (!parts.length) continue
    const body = parts.join('\n')
    return cfg.twinStripMarkers === false ? body : stripSpecialTokens(body)
  }
  return ''
}

/**
 * 把最近若干条消息拍平成**一段普通文本**（角色只作行首标签），并把特殊标识符清掉。
 * 这是 twinContextMode='flatten' 的背景块：监察看到的是文字记录，不是可续写的对话结构。
 */
export function flattenTranscript(base, cfg) {
  // 按**轮次**取（用户指定：上 10 轮），一轮 = 一条人类发言 + 它后面跟着的动作。
  // **不设字数上限**（用户指定）：正文回答与用户输入全量带上；体积控制唯一手段是
  // 不写工具调用/工具结果（twinIncludeTools，默认关）——实测那才是拖慢速度的东西。
  const rounds = Number(cfg.twinTranscriptRounds ?? 10)
  // v4 起插件消息 kind 形如 'plugin:<包名>'（旧形态 kind='plugin' 保留兼容）——一律不进监察转录
  const usable = base.filter(m => {
    const k = m?.source?.kind
    return k !== 'plugin' && !(typeof k === 'string' && k.startsWith('plugin:')) && m?.role !== 'system'
  })

  const groups = []
  let cur = []
  for (const m of usable) {
    const isHuman = m?.role === 'user' && m?.source?.kind === 'user'
    if (isHuman && cur.length) { groups.push(cur); cur = [] }
    cur.push(m)
  }
  if (cur.length) groups.push(cur)
  if (!groups.length) return ''

  const picked = rounds > 0 ? groups.slice(-rounds) : groups.slice(-1)
  const texts = picked.map(group => {
    const lines = []
    for (const msg of group) {
      const body = readableText(msg, cfg)
      if (!body) continue
      const who = msg.role === 'assistant' ? '执行侧' : msg.source?.kind === 'user' ? '用户' : '工具'
      lines.push(`【${who}】${body}`)
    }
    return lines.join('\n')
  }).filter(t => t.trim())

  const dropped = groups.length > picked.length
  const out = [dropped ? '…（更早的轮次未附上）' : '', texts.join('\n\n———\n\n')].filter(Boolean).join('\n')
  return cfg.twinStripMarkers === false ? out : stripSpecialTokens(out)
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

const CONFORM_PHRASES = ['无偏离', '没有偏离', '不存在偏离', '未发现偏离', '无需纠正', '无需修改', '没问题', '可以继续', '无需改动', '不算偏离', '不构成偏离', '未越过', '没有越过', '不算问题']
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
  // ① 第一行**以结论词开头**就按它判 —— 不限长度（实测模型会写「通过：<很长的理由>」，
  //    旧实现要求首行 ≤30 字，于是这种答案被漏掉、退回全文扫词时被后面的"偏离"抢走，判反了）。
  const decorated = stripDecoration(firstLine)
  if (/^(通过|符合|没问题|无偏离|没有偏离|无需纠正|不算偏离)/.test(decorated)) marker = 'conform'
  else if (/^(纠正|不符合|不一致|偏离|有问题|未通过|不通过)/.test(decorated)) marker = 'deny'
  if (marker) {
    // 理由 = 首行结论词之后的剩余部分 + 后续行
    const restOfFirst = firstLine.replace(/^[\s#*`>【】\[\]〔〕「」『』]*[^：:]{0,8}[：:]\s*/, '').trim()
    const tail = lines.slice(head + 1).join('\n').trim()
    body = [restOfFirst && restOfFirst !== firstLine ? restOfFirst : '', tail].filter(Boolean).join('\n').trim()
  }
  // ② 退回关键词扫（首行短句、或结论词夹在句中）
  if (!marker && firstLine.length <= 30) {
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
    stepOpen: false, // 此刻会话里有没有打开的 step（由 session/event 维护；写入安全闸的第二道判据）
    reviewing: false,
    twinDown: false, // 本回合监察已判定不可用：不再重试，逐条拒掉，等结果落盘后再中断回合
    unavailTurns: 0, // 连续「监察不可用」的回合数（任一次成功裁决即归零；跨回合累计，不随回合重置）
    degradedTurn: false, // 本回合已降级放行（连续不可用超过 DEGRADE_AFTER_TURNS 后，只探测不拦截）
    lastProvider: '', // 该会话最近一次 llm 调用的 provider/model（llm/stream 钩子记账）
    lastModel: '', //   —— 后台代理会话没有 requestContext，全靠它兜底
    bgSeen: false, // 已识别为后台代理会话（只记录模式，日志里只报一次）
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
 * 另外：预算用尽（仅当配置为正数）/ 未解决出口 → 静默跳过（不审查、不报错）。
 */
export function evaluateGate(st, cfg, kind, now, actionSeq, prevKind) {
  if (st.unresolved) return { review: false, why: 'unresolved-exit' }
  if (prevKind !== kind && cfg.twinChainHeadAlways) return { review: true, why: prevKind === null ? 'chain-head' : 'kind-switch' }
  const budgetMax = Number(cfg.twinMaxReviewsPerTurn)
  if (Number.isFinite(budgetMax) && budgetMax > 0 && st.budget >= budgetMax) return { review: false, why: 'budget' }
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
  st.degradedTurn = false // 降级态只描述"当前回合"；unavailTurns 跨回合累计，不在这里清
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
  // DSH v4（2026-09-26）：kind:'plugin' 已废弃，必须写 producer-owned 'plugin:<包名>'。
  const source = { kind: 'plugin:' + PLUGIN_NAME }
  if (form === 'notice') source.form = 'notice', source.summary = summary || text
  else if (form) source.form = form
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source }
}

/**
 * 造一条助手消息。**这里统一保证带 reasoning 块**——上游 thinking 模式要求回传的每条助手消息
 * 都带 `reasoning_content`，缺了就 400：
 *   `The reasoning_content in the thinking mode must be passed back to the API.`
 * 我们贡献的助手消息（监察记录、结构伪造尾、以及任何后续新增）全都走这个函数，
 * 所以在这一处兜底，就不必逐个调用点去记得补 reasoning。
 */
function assistantRecordMessage(content, provider, model, fallbackReasoning = '（监察：本条没有留下思考正文。）') {
  const blocks = Array.isArray(content) ? [...content] : []
  if (!blocks.some(b => b && b.type === 'reasoning')) {
    blocks.unshift({ type: 'reasoning', text: String(fallbackReasoning || '（没有思考正文）') })
  }
  return {
    id: randomUUID(),
    role: 'assistant',
    content: blocks,
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
  // 思考模式下历史里每条 assistant 都必须带 reasoning_content，否则上游直接报
  // "The `reasoning_content` in the thinking mode must be passed back to the API."
  // 所以兜底也补 reasoning 块，而不是补空 text 块。
  if (!content.length) content.push({ type: 'reasoning', text: '（判据已逐条对照完毕。）' })
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
  // requestContext 拿不到时（后台代理会话不在 agents 注册表）退回 llm/stream 钩子
  // 记账的最后一次 provider/model —— 没有它，inbox 驱动的会话永远零监察。
  const st = stateFor(session.id)
  const provider = ctxInfo?.provider || st.lastProvider || ''
  const model = ctxInfo?.model || st.lastModel || ''
  if (!provider || !model) {
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
  const instruction = buildInstruction(criteria.doc, targetDesc, {
    ...meta,
    userInstruction: lastUserInstruction(base),
    prefill: cfg.twinPrefill,
    extraRequirements: cfg.twinPrompt,
    contextText: contextTextFor(base, cfg),
    lessonsText: cfg.twinReviewLessons === false ? '' : lessonsReviewText(cfg, agent),
  })
  // 上下文模式：'full' 把执行侧整段对话原样带上；其余模式只送这一份指令文档（背景已写进第二节）。
  const isolated = String(cfg.twinContextMode || 'flatten').toLowerCase() !== 'full'
  const messages = isolated
    ? [userMessage(instruction, 'instructions')]
    : [...base, userMessage(instruction, 'instructions')]
  if (cfg.twinForge !== false) messages.push(forgedAssistantMessage(cfg, provider, model))
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
        provider,
        model,
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
      let parsed = parseVerdict(text)
      // 前缀续写拼接：伪造尾消息的正文带 JSON 开头时，模型往往只补尾巴
      // （如 ` true, "reason": "…"}`，回复里没有 `{`）——单看回复解析不出来，
      // 拼回前缀才是一份完整裁决。仅当裸解析失败且确有 JSON 前缀时才走这条。
      if (!parsed.ok && text.trim() && String(cfg.twinForgeContent || '').trim().startsWith('{')) {
        parsed = parseVerdict(`${String(cfg.twinForgeContent).trim()} ${text}`)
      }
      if (parsed.ok) {
        return { status: parsed.verdict.conform ? 'conform' : 'deny', verdict: parsed.verdict, thinking, provider, model }
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
      log?.warn?.(`[${PLUGIN_NAME}] 监察调用失败（第 ${attempt}/${attempts} 次）：${lastError}［${provider}/${model}］；${cfg.twinRetryDelayMs}ms 后重试`)
      await sleep(Math.max(0, Number(cfg.twinRetryDelayMs) || 5000), signal)
    }
  }
  log?.warn?.(`[${PLUGIN_NAME}] 监察不可用（已重试 ${attempts} 次）：${lastError}［${provider}/${model}］`)
  return { status: 'unavailable', thinking: '', error: lastError }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 6. 落盘：监察思考进会话（原生渲染）+ 一份 jsonl 备份
 * ────────────────────────────────────────────────────────────────────────── */

export function appendTwinRecord(agent, st, res, { kind, log, turn, step, inSession = true } = {}) {
  const verdict = res.verdict || { conform: false, reason: '', correction: '' }
  const head = verdict.conform ? '通过' : '纠正'
  const body = verdict.conform ? verdict.reason || '未发现偏离' : verdict.correction || verdict.reason || ''
  const text = `〔监察〕${head}：${body}`
  // 思考模式下，历史里的每条 assistant 消息都必须把 reasoning_content 带回给上游，
  // 否则下一轮请求会被直接拒收："The `reasoning_content` in the thinking mode must be
  // passed back to the API."（2026-09-19 实测事故：监察这次没留下思考正文，记录只剩 text 块）。
  // 所以 reasoning 块永远在场，没有正文时给一句占位。
  // 思考正文**默认不进上下文**（用户 2026-09-19 指定）：会话里只留一句标记 `〔监察思考〕`。
  // 不能整块省掉 reasoning —— thinking 模式要求回传的助手消息必须带 reasoning_content，
  // 缺了会被上游 400（"…must be passed back to the API."），所以留一句最短的。
  // 要看全文：jsonl 备份里一直有；要恢复"思考进会话"，把 twinRecordThinking 设 true（届时按 twinRecordChars 截断）。
  const recCfg = loadConfig()
  const thinkingText = recCfg.twinRecordThinking === true
    ? `〔监察思考〕${clipText(String(res.thinking || '').trim(), Number(recCfg.twinRecordChars ?? 1200)) || '（本次监察没有留下思考正文）'}`
    : '〔监察思考〕'
  const content = [
    { type: 'reasoning', text: thinkingText },
    { type: 'text', text },
  ]

  const session = agent?.session
  const sessionId = session?.id
  const turnNo = turn ?? st.turn
  const stepNo = step ?? st.step
  // 第三道闸（本函数自己兜）：**必须有 open step**。turn/step 快照会过期，
  // 光看它不是 null 不够 —— 落盘时那一步可能已经 step/end 了。
  const stepOpen = session ? sessionStep(session) : null
  if (inSession && session && turnNo != null && stepNo != null && stepOpen !== false) {
    try {
      session.append(
        'assistant/message',
        { turn: turnNo, step: stepNo, message: assistantRecordMessage(content, res.provider, res.model), stream: [] },
        { surfaceOp: 'append' },
      )
    } catch (err) {
      log?.warn?.(`[${PLUGIN_NAME}] 监察记录追加失败（不影响裁决）：${err?.message || err}`)
    }
  } else if (!inSession) {
    log?.debug?.(`[${PLUGIN_NAME}] 监察记录按设置不写会话（只进 jsonl）`)
  } else {
    log?.info?.(
      `[${PLUGIN_NAME}] 监察记录跳过会话写入（${stepOpen === false ? '当前没有打开的 step' : 'turn/step 快照不可用'}）——只进 jsonl`,
    )
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
  st.unavailTurns = 0 // 有一次成功裁决就收严（降级是连续不可用才触发的临时态）
  st.degradedTurn = false
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

/**
 * 会话此刻有没有打开的 step —— **本机复算**，不看 turn/step 快照。
 *
 * 为什么需要它：宿主的 token meter 是状态机（`@deepseek-ai/dsh-token-meter` 的 `_foldEvent`），
 * `assistant/message` 必须匹配当前 open step，否则抛
 *   `assistant/message at seq N has no matching step/start event`
 * → basic-compaction-engine 每次压缩都失败、这条会话再也压不出摘要（2026-09-19 实测事故）。
 * `pairingOk()` 只管线格式（tool_calls 有没有配上结果），拦不住这一类 —— 所以写入前必须再问一句
 * "现在到底有没有 step 开着"。
 *
 * turn/step 快照（st.turn/st.step）是会过期的：写记录用的是**入队时**的 turn/step，
 * 而落盘发生在之后，中间可能已经 step/end 或进了新一步。
 */
export function sessionStep(session) {
  try {
    let events = null
    if (typeof session?.snapshotEvents === 'function') events = session.snapshotEvents()
    else if (Array.isArray(session?.events)) events = session.events // DSH 2.0.9 起不再暴露 events，留作兼容
    if (!Array.isArray(events)) return null
    let open = false
    for (const e of events) {
      if (!e || typeof e.type !== 'string') continue
      if (e.type === 'step/start') open = true
      else if (e.type === 'step/end' || e.type === 'turn/start' || e.type === 'turn/end') open = false
    }
    return open
  } catch {
    return null
  }
}

/**
 * 会话消息序列现在能不能安全写入 —— 落盘前的最后一道闸。
 *
 * 判据是**配对**而不是"结果存在就行"：每条 assistant 消息里的每个 tool-call，
 * 后面必须**紧跟**一段连续的工具结果把它们的 id 全部覆盖。
 * 中间插了任何别的消息（这正是 2026-09-19 那次事故的坏法）都算不合法 —— 上游会 400。
 * 好处是双向的：既拦住"我们写进工具窗口"，也拦住"往一条已经坏了的会话里再写"。
 */
export function pairingOk(messages) {
  const list = Array.isArray(messages) ? messages : []
  const idsOf = msg => (Array.isArray(msg?.content) ? msg.content : [])
    .filter(b => b && b.type === 'tool-result' && b.toolCallId).map(b => b.toolCallId)
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    if (m?.role !== 'assistant') continue
    const calls = (Array.isArray(m.content) ? m.content : [])
      .filter(b => b && b.type === 'tool-call' && b.id).map(b => b.id)
    if (!calls.length) continue
    const need = new Set(calls)
    let j = i + 1
    while (j < list.length) {
      const ids = idsOf(list[j])
      if (!ids.length) break // 连续段断了：后面即使补了结果也不算合法
      for (const id of ids) need.delete(id)
      j += 1
    }
    if (need.size) return false
  }
  return true
}

/** 尾巴能不能写：线格式配对 **且** 生命周期（有 open step）两道都要过。 */
export function tailIsWritable(agent) {
  const session = agent?.session
  if (!session?.deriveMessages) return false
  let msgs = []
  try { msgs = session.deriveMessages() || [] } catch { return false }
  if (!pairingOk(msgs)) return false
  // 第二道：没有 open step 时写 assistant/message 会让宿主 token meter 抛错（压缩永久失败）。
  if (sessionStep(session) === false) return false
  return true
}

/** 把排队的写入落到会话里。**只在工具窗口之外**（step/end、turn/end）调用。 */
export function flushPending(agent, st, log, attempt = 0) {
  const items = st.pending || []
  if (!items.length) return []
  if (!tailIsWritable(agent)) {
    // 尾部还在工具窗口里（assistant 已发 tool_calls、结果未落盘）：推迟，绝不硬写。
    if (attempt < 5) {
      log?.debug?.(`[${PLUGIN_NAME}] 尾部还在工具窗口，落盘推迟（第 ${attempt + 1} 次）`)
      setTimeout(() => flushPending(agent, st, log, attempt + 1), 1500)
    } else {
      log?.warn?.(`[${PLUGIN_NAME}] 落盘推迟到上限仍不安全，丢弃 ${items.length} 项（宁可丢记录，不写坏会话）`)
      st.pending = []
    }
    return []
  }
  st.pending = []
  const session = agent?.session
  const done = []
  for (const item of items) {
    try {
      if (item.kind === 'record') {
        // 默认**不往会话里写**（用户 2026-09-19 定）：这类记录落在 step 之外，会让宿主的 token meter
        // 抛 "assistant/message at seq … has no matching step/start event"，进而让
        // basic-compaction-engine 每次压缩都失败（实测：重启后一次压缩都没成功，会话只能撞窗口上限），
        // 而且它还会随每轮请求重发、推高上下文。记录照旧进 jsonl 与日志，要看随时能看；
        // 确实要让它在对话里显形，把 twinRecordInSession 设 true 即可。
        const inSession = st.recordInSession ?? (loadConfig().twinRecordInSession === true)
        appendTwinRecord(agent, st, item.res, { kind: item.reviewKind, log, turn: item.turn, step: item.step, inSession })
        done.push(inSession ? 'record' : 'record-jsonl-only')
        if (inSession) log?.info?.(`[${PLUGIN_NAME}] 监察记录已写进会话：turn ${item.turn} step ${item.step}（${item.reviewKind}）`)
        else log?.info?.(`[${PLUGIN_NAME}] 监察记录只落 jsonl（不写会话）：turn ${item.turn} step ${item.step}（${item.reviewKind}）`)
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

/* ──────────────────────────────────────────────────────────────────────────
 * 7. 工具闸门：tools/pre-execute
 * ────────────────────────────────────────────────────────────────────────── */

export const NOTE_TOOL = '_twin_note'

/** 自己发起的调用（监察调用自身 / 内部工具）不进闸门，否则会自我递归。 */
let twinDepth = 0
export function twinBusy() {
  return twinDepth > 0
}
/** 连续 N 个回合监察不可用后降级放行（2026-09-19 D0304 拍板：保留 fail-closed，另有上限降级）。 */
const DEGRADE_AFTER_TURNS = 2
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
      // 本回合已判定监察不可用。正常态逐条拒掉；降级态（连续多回合不可用）放行。
      // 每条拒绝都自带一条工具结果（形态合法），固定文本与中断回合已排队，等本步结果落盘后执行。
      if (st.degradedTurn) return next()
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
      st.unavailTurns += 1
      if (st.unavailTurns > DEGRADE_AFTER_TURNS) {
        // 连续多回合不可用：降级放行（2026-09-19 D0304 拍板方案，今日整机被锁后落地）。
        // 本回合剩余调用直接过、不再 deny、不再中断回合；每回合链首仍会探测，
        // 监察一恢复（queueRecord 归零）自动收严回 fail-closed。
        if (!st.degradedTurn) {
          st.degradedTurn = true
          log?.warn?.(`[${PLUGIN_NAME}] 监察连续 ${st.unavailTurns} 个回合不可用 → 降级放行（每回合仍探测，成功即自动收严）`)
        }
        st.twinDown = true // 本回合剩余调用跳过审查（走上面的放行分支）
        return next()
      }
      // 工具闸门 fail-closed：宁可停住，也不放行一个不可逆的重操作。
      // 注意：这里**只返回 deny**，写会话与中断回合都排队到 step/end ——
      // 现在正处在工具窗口里，写任何东西都会毁掉这条会话（见上面那段纪律）。
      log?.warn?.(`[${PLUGIN_NAME}] 监察不可用（连续第 ${st.unavailTurns} 回合）→ 固定文本 + 中断回合（排队到本步工具结果落盘后执行）`)
      st.twinDown = true
      queueUnavailable(st, cfg)
      return { kind: 'deny', reason: String(cfg.twinUnavailableText) }
    }

    queueRecord(st, res, 'tool')
    if (res.status === 'conform') return next()

    st.corrections += 1
    if (st.corrections >= 2) st.unresolved = true
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

/**
 * 合成 `_twin_note` 工具调用的分块（宿主会校验块语法：start → delta → end）。
 *
 * **先补一个 reasoning 块**：这条合成出来的助手消息只有 tool-call、没有思考，而 thinking 模式
 * 回传时缺 `reasoning_content` 会被上游直接 400（"…must be passed back to the API."）。
 * 序号取 `index - 1`（调用方给的合成号从 900 起，往前一位空着），保证块序号递增且不撞车。
 */
export function noteCallChunks(index, id, args) {
  const json = JSON.stringify(args)
  const reasonIndex = Math.max(0, Number(index) - 1)
  const reasonText = '（监察：这一步准备输出的正文未通过审查，已拦下并改为提要求。）'
  return [
    { type: 'block-start', index: reasonIndex, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: reasonIndex, text: reasonText },
    { type: 'block-end', index: reasonIndex, block: { type: 'reasoning', text: reasonText } },
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

/**
 * 后台代理会话的只读审查。inbox 驱动的会话不在 agents 注册表里，拿不到
 * session.append / agent.inject / agent.cancel 这些通道——所以这里：
 *   - 裁决照常做、照常落 jsonl（shim 的 append 是 noop，绝不写会话）；
 *   - 正文永远放行（deny 只记档 + warn，不拦流）；
 *   - 监察不可用时静默放行（不附加申明，避免每轮刷屏）。
 */
export function observeOnlyTextGate({ ctx, cfg, st, options, next, log }) {
  const shimSession = {
    id: options.sessionId,
    requestContext: () => (st.lastProvider && st.lastModel ? { provider: st.lastProvider, model: st.lastModel } : null),
    deriveMessages: () => [],
    append: () => ({}),
  }
  const shimAgent = { session: shimSession, inject: () => {}, cancel: () => {} }
  const upstream = next()
  return textGate({
    cfg,
    st,
    upstream,
    signal: options.signal,
    log,
    unavailableText: '',
    review: async ({ kind, text }) => {
      markReviewed(st)
      let res
      twinDepth += 1
      try {
        res = await callTwin(ctx, cfg, shimAgent, {
          kind,
          targetDesc: describeTarget(kind, { text }),
          meta: { turn: st.turn, step: st.step },
          signal: options.signal,
          log,
        })
      } finally {
        twinDepth -= 1
      }
      if (res.status === 'conform' || res.status === 'deny') {
        st.unavailTurns = 0
        st.degradedTurn = false
        // 直接写 jsonl 备份：后台会话没有安全的会话写入时点，pending 队列也可能
        // 等不到 step/end 事件——这里同步落盘最可靠。
        appendTwinRecord(shimAgent, st, res, { kind, log, turn: st.turn, step: st.step, inSession: false })
        if (res.status === 'deny') {
          log?.warn?.(`[${PLUGIN_NAME}] 后台会话判偏离（只记录不拦截）：${clipText(res.verdict?.correction || res.verdict?.reason || '', 200)}`)
        }
        // 伪装成 conform：textGate 原样放行正文
        return { status: 'conform', verdict: res.verdict, thinking: res.thinking }
      }
      if (res.status === 'unavailable') {
        st.unavailTurns += 1
        log?.warn?.(`[${PLUGIN_NAME}] 后台会话监察不可用（连续第 ${st.unavailTurns} 次）——只记录模式继续放行`)
      }
      // unavailable / skipped：静默放行
      return { status: 'skipped', thinking: '', error: res.error || '' }
    },
  })
}

/* ──────────────────────────────────────────────────────────────────────────
 * 8.5 通用教训作为审查材料（2026-09-19 自流变·记忆移交；不注入执行侧）
 *
 * 分工：教训的**生产**（从记忆库蒸馏、list/add/remove）留在流变·记忆的
 *   `_dsh_external_dsh_liubian_lessons` 工具；本插件把清单作为**审查材料**附进
 *   送监指令——被审动作违反适用条目的算偏离。教训不注入执行侧的上下文：
 *   注入靠模型自觉遵守，审查才是闸门强制。
 * 交接面：~/.dsh/liubian/lessons*.json（{updatedAt, lessons:[…]}），本插件只读。
 * ────────────────────────────────────────────────────────────────────────── */

function lessonsDir(cfg) {
  const d = String(cfg.twinLessonsDir || '').trim()
  return d || join(DSH_HOME, 'liubian')
}

export function lessonsFilePath(cfg, scope = 'global', ws = '') {
  return scope === 'workspace' && ws
    ? join(lessonsDir(cfg), `lessons-${ws}.json`)
    : join(lessonsDir(cfg), 'lessons.json')
}

function loadLessons(cfg, scope = 'global', ws = '') {
  if (scope === 'workspace' && !ws) return [] // 守卫：没有工作区名绝不回落到全局文件（会顶着空标签复读全局清单）
  try {
    const meta = JSON.parse(readFileSync(lessonsFilePath(cfg, scope, ws), 'utf8').replace(/^\uFEFF/, ''))
    const list = Array.isArray(meta && meta.lessons) ? meta.lessons : []
    return list.map(t => String(t || '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** 会话的工作区名：session.header.cwd 的最后一段（与流变·记忆同源）；拿不到则只对照全局教训。 */
export function resolveTwinWorkspace(agent) {
  const cwd = String((agent && agent.session && agent.session.header && agent.session.header.cwd) || '')
  if (!cwd) return ''
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}

/**
 * 组装"通用教训（对照参考）"一节的正文：全局 + 工作区两份清单，条数与总长有上限。
 * 没有任何可用的教训时返回 ''（该节整体不出现）。
 */
export function lessonsReviewText(cfg, agent) {
  const ws = resolveTwinWorkspace(agent)
  const maxN = Math.max(1, Number(cfg.twinLessonsMax) || 20)
  const budget = Math.max(400, Number(cfg.twinLessonsChars) || 2400)
  const groups = []
  let used = 0
  for (const [scope, wsName] of [['global', ''], ['workspace', ws]]) {
    const list = loadLessons(cfg, scope, wsName)
    if (!list.length) continue
    const label = scope === 'workspace' ? `【工作区「${wsName}」教训】` : '【全局教训】'
    const lines = []
    for (let i = 0; i < Math.min(list.length, maxN); i += 1) {
      const seg = `${i + 1}. ${clipText(list[i], 120)}`
      if (used + seg.length > budget) break
      lines.push(seg)
      used += seg.length
    }
    if (lines.length) groups.push(`${label}\n${lines.join('\n')}`)
  }
  if (!groups.length) return ''
  return [
    '与判据同规则：条目适用于被审动作才对照，不适用跳过；判偏离时在理由里点名第几条、并引用动作里对应的证据，不要逐条复述这份清单。',
    ...groups,
  ].join('\n')
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
      st.stepOpen = false
    } else if (event.type === 'step/start') {
      const st = stateFor(session.id)
      // 兜底：上一步结束时若没排空，这里也排一次（此刻上一步的结果必然已落盘）。
      scheduleFlush(ctx, session, st, log)
      st.turn = event.data?.turn ?? st.turn
      st.step = event.data?.step ?? null
      st.stepOpen = true
    } else if (event.type === 'step/end') {
      const st = stateFor(session.id)
      // 这一步的工具结果此刻已经全部落盘 —— 唯一安全的落盘点（见"落盘的时机纪律"）。
      scheduleFlush(ctx, session, st, log)
      st.step = null
      st.stepOpen = false
    } else if (event.type === 'turn/end') {
      const st = stateFor(session.id)
      scheduleFlush(ctx, session, st, log)
      st.step = null
      st.stepOpen = false
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
      const st = stateFor(options.sessionId)
      // 先记账再走 skip 判断：后台代理会话（inbox 驱动、不在 agents 注册表）没有
      // requestContext，全靠这里留下的 provider/model 兜底。
      if (options.provider && options.model) {
        st.lastProvider = options.provider
        st.lastModel = options.model
      }
      if (options.purpose) return next() // session-title / compaction 之类的内部调用不审
      const agent = ctx.agents?.get?.(options.sessionId)
      if (!agent) {
        // 后台代理会话：没有 agent 就没有 _twin_note / 会话写入 / 中断回合通道
        // → 监察转只记录模式（裁决落 jsonl，正文永远放行）。
        if (!st.bgSeen) {
          st.bgSeen = true
          log?.info?.(`[${PLUGIN_NAME}] 会话 ${options.sessionId} 不在 agents 注册表（后台代理）→ 监察转只记录模式`)
        }
        return observeOnlyTextGate({ ctx, cfg, st, options, next, log })
      }
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
          } else if (res.status === 'unavailable') {
            st.unavailTurns += 1
            if (st.unavailTurns > DEGRADE_AFTER_TURNS) {
              // 降级：文本本来就走 fail-open，这里只把"末尾固定申明"也省掉，
              // 避免监察长时间故障时每轮回复都被刷屏（恢复后自动收严）。
              if (!st.degradedTurn) {
                st.degradedTurn = true
                log?.warn?.(`[${PLUGIN_NAME}] 监察连续 ${st.unavailTurns} 个回合不可用 → 文本降级放行（不再附申明，恢复后自动收严）`)
              }
              return { status: 'skipped', thinking: '', error: res.error || '' }
            }
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
      + `预算=${Number(cfg.twinMaxReviewsPerTurn) > 0 ? cfg.twinMaxReviewsPerTurn : '不限'} 重试=${cfg.twinRetryMax}×${cfg.twinRetryDelayMs}ms（无独立开关；停用本插件即停用孪生）`,
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
  observeOnlyTextGate,
  sanitizeForTwin,
  placeholderToolResult,
  forgedAssistantMessage,
  stripSpecialTokens,
  flattenTranscript,
  contextTextFor,
  queueRecord,
  sessionStep,
  tailIsWritable,
  lessonsFilePath,
  resolveTwinWorkspace,
  lessonsReviewText,
  queueUnavailable,
  flushPending,
  tailIsWritable,
  pairingOk,
  appendTwinRecord,
}
