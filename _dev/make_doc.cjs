/**
 * 生成《送监格式与源码》参考文档：把 impl.mjs 里送监链路的函数原文抽出来，
 * 配上消息格式说明，落成一份可直接看的 markdown。改 impl.mjs 后重跑即可更新。
 *
 *   node _dev/make_doc.cjs
 */
process.noAsar = true
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'lib', 'impl.mjs')
const OUT = path.join(__dirname, '送监格式与源码.md')
const lines = fs.readFileSync(SRC, 'utf8').split('\n')

/** 从某一行（含签名）抽到顶格的那个 } 为止 */
function bodyOf(signature) {
  const start = lines.findIndex(l => l.startsWith(signature))
  if (start < 0) return `// 未找到：${signature}`
  let end = start
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') { end = i; break }
  }
  return lines.slice(start, end + 1).join('\n')
}

const want = [
  'export function buildInstruction',
  'export function sanitizeForTwin',
  'export function placeholderToolResult',
  'export function stripSpecialTokens',
  'export function flattenTranscript',
  'export function contextTextFor',
  'export function forgedAssistantMessage',
  'export async function callTwin',
  'export function parseVerdict',
  'export function markerOf',
  'function userMessage',
  'function assistantRecordMessage',
  'export function appendTwinRecord',
  'export function queueRecord',
  'export function flushPending',
  'export function handleToolGate',
]

const doc = `# 孪生监察 · 送监格式与源码

> 本文由 \`_dev/make_doc.cjs\` 从 \`lib/impl.mjs\` 抽取生成，行号会随代码变化，函数名是稳定锚点。

## 一、送监请求长什么样

监察调用 = **执行侧那条会话的消息原样 + 末尾追加一条指令**，用**会话自己的** provider/model，
**不带 tools**（所以模型不该调工具）。超时看的是"两次输出之间的空档"（默认 5 秒），不是整段耗时。

\`\`\`js
ctx.llm.stream({ provider, model, messages, signal })   // messages = [...sanitizeForTwin(deriveMessages()), 指令]
\`\`\`

## 二、消息的内部格式（\`_dev/ctx/messages.json\`）

规则与宿主 \`deriveMessages()\` 同源：会话日志里只有这四类事件会产生消息，取事件里的 \`message\` 字段 ——
\`user/message\` / \`system/message\` / \`assistant/message\` / \`tool/result\`。

一条消息 = \`{ id, role, content: [块...], source }\`

| 字段 | 说明 |
|---|---|
| \`id\` | 必有（uuid）。缺了会写坏会话日志，宿主直接拒读 |
| \`role\` | \`user\` / \`assistant\` / \`system\`。注意：**工具结果也是 role:'user'**，靠块类型区分 |
| \`content\` | 块数组，见下表 |
| \`source\` | \`{kind:'user'}\` 人类原话；\`{kind:'model',provider,model}\` 模型产出的消息；\`{kind:'tool',callId}\` 工具结果；\`{kind:'plugin',plugin,form[,summary]}\` 插件注入块 |

块的类型：

| 块 | 形状 | 出现在 |
|---|---|---|
| 文本 | \`{type:'text', text}\` | 三种 role 都可能 |
| 思考 | \`{type:'reasoning', text}\` | assistant |
| 工具调用 | \`{type:'tool-call', id, name, arguments}\`（\`arguments\` 是 JSON 字符串） | assistant |
| 工具结果 | \`{type:'tool-result', toolCallId, content:[{type:'text',text}], isError:bool}\` | role:'user' 的消息里 |

**线格式硬约束**（踩过事故）：assistant 消息里每个 \`tool-call\` 的 \`id\`，后面必须紧跟对应的
\`tool-result\`；工具闸门被调用的时刻正处在"调用已落盘、结果未落盘"的窗口里，
所以送监前要先用 \`sanitizeForTwin()\` 给未执行的调用补一条占位结果。

## 三、转成 chat/completions 的 wire 格式

\`_dev/ctx/wire.json\` 就是转好的结果，规则（见 \`dump_context.cjs\` 的 \`toWire\`）：

- assistant：\`text\` 块拼成 \`content\`；\`reasoning\` 块进 \`reasoning_content\`；\`tool-call\` 块进 \`tool_calls\`（\`{id,type:'function',function:{name,arguments}}\`）
- \`tool-result\` 块拆成独立的 \`{role:'tool', tool_call_id, content}\` 消息
- 其余按 \`role: content=纯文本\`

> ⚠️ 这是按抓到的真实请求/响应反推的对应关系；\`reasoning_content\` 这家上游是否接受回填、以及
> 是否允许最后一条是 assistant（前缀续写），都需要真机试。

## 四、末尾那条指令的拼装顺序

\`role\`（判据文件的 role）→ \`usage\` → 44 条判据逐行 \`[场景] when → q\` → \`contract\`（结论词约定）
→ 空行 → 待审对象（工具名 + 参数 / 准备输出的话）→ 用户原话（\`«…»\`）→ **伪造尾巴 \`twinPrefill\`**。

伪造尾巴是这一版的关键变量（用户指定）：在最后直接写出"思考到此结束"这个阶段标记，
试图把模型推进作答状态、而不是续写执行侧对话。默认值在 \`DEFAULTS.twinPrefill\`，
可以直接改配置 \`~/.dsh/liubian-twin/config.json\`，不动代码。

## 五、脚本

\`\`\`bash
# 1) dump 出送监上下文（不调 API、不改状态），产物在 _dev/ctx/
node _dev/dump_context.cjs [session-id] [待审工具名] [参数JSON]

# 2) 手改 _dev/ctx/messages.json 或 instruction.txt 后，按自己的 key 直发
node _dev/send_context.cjs --key <API_KEY> --base-url <URL> --model deepseek-flash \\
     [--messages _dev/ctx/wire.json] [--idle-ms 5000] [--max-tokens 8000] [--out _dev/ctx/reply.txt]
\`\`\`

## 六、现场已知事实（2026-09-18 实测）

- 送监请求形态**已修好**：补占位结果后不再被上游拒收（修复前 108ms 空回复 ×5）。
- \`twinTimeoutMs\` 原来 30 秒整段掐 → 大上下文里模型还在思考就被切断，日志表现为
  "只思考没有作答（思考 23000 字；分块类型：block-start/reasoning-delta/finish）"。已改为 idle 判据。
- 目前**最主要的失败**是模型不审、续写执行侧：日志里出现过它输出
  "现在是这么个情况：**插件确实活了、闸门真的在拦……**"，也出现过它直接吐工具调用标记
  （两条全角竖线夹 \`DSML\` 的那种），只有少数几次真的给了结论词。
- 该标记在 app.asar 里搜不到（21810 个文件、0 命中）→ 它是**模型侧特殊标记**，不是宿主生成的；
  只在请求没声明工具、模型却硬要调工具时漏成文本。

---

# 附：源码（从 impl.mjs 抽取）

${want.map(sig => `## \`${sig.replace(/^export /, '').replace(/^async /, '')}\`\n\n\`\`\`js\n${bodyOf(sig)}\n\`\`\`\n`).join('\n')}
`

fs.writeFileSync(OUT, doc, 'utf8')
console.log('已写出:', OUT, '|', doc.length, '字')
console.log('抽取到的函数:', want.map(s => s.split(' ')[s.split(' ').length - 1]).join(', '))
