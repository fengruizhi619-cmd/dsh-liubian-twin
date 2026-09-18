# dsh-liubian-twin —— 流变·孪生（DSH 版）

在同一会话里挂一个**监察智能体**：用**会话自己的模型**审执行智能体的每一个动作
（工具调用 / 准备输出的话），偏离用户指令时**当场拦下**并给出可直接执行的纠正。

与 `dsh-liubian`（流变·记忆）**功能上不互通**——不引它的代码、不读它的数据与配置；
只在命名上归流变系列（`dsh-liubian` / `dsh-liubian-embed` / `dsh-liubian-twin`）。
监察要看的那些固定块（接入卡 / 教训块 / 能力卡 / 逐轮提醒）本来就作为会话消息活在日志里，
`session.deriveMessages()` 原样带出，所以一行流变代码都不需要。

## 止血路径（先看这条）

**本插件没有开关**：孪生随**本插件**启用/停用。

- 想停掉孪生 → 停用／卸载 `dsh-liubian-twin`；**记忆注入不受影响**（那是 `dsh-liubian` 的事）。
- 监察 API 不可用时（重试 5 次 × 5 秒仍失败）：工具闸门把所有工具**逐条拒掉**
  （模型只看到 `Error: 监察api不可用，请尝试关闭插件或者稍后尝试`，什么都执行不了），
  并把固定文本 + 中断回合**排队到这一步的工具结果落盘之后**执行；文本闸门则放行原文、末尾补同一句申明。
- 忘了自己在跑孪生？看日志里的 `[dsh-liubian-twin] v… 已挂载` 与 `~/.dsh/liubian-twin/sessions/*.jsonl`。

## 两个闸门

| 闸门 | 挂在哪 | 停住的是什么 | 判偏离时 |
|---|---|---|---|
| 工具闸门 | `tools/pre-execute`（prepend） | 工具**还没派发** | 返回 deny → 工具不执行，模型收到 `Error: [监察] …`（并另注入一条纠正） |
| 文本闸门 | 包裹 `llm/stream` | 该步的**文本分块被扣住**，step 不结束 | 原文整块丢弃，改合成一次 `_twin_note` 工具调用，用它的工具结果把纠正回给模型 |

两条都是**阻塞式**：审查期间执行侧零产出（不放行部分文本、不让工具先行）。
审查结束追加一条 `assistant/message`（`reasoning` + `〔监察〕…` 文本），吃 DSH 原生思考行渲染。

### ⚠️ 落盘的时机纪律（2026-09-18 实测事故，两条都不能破）

线格式要求「assistant 带的每个 `tool_call_id`，后面必须紧跟对应的 tool 消息」。工具闸门被调用时，
assistant 那条带 `tool_calls` 的消息**已经落盘、工具结果还没落盘** —— 这个窗口里：

1. **送监请求必须先补占位工具结果**。裸着送上去必被上游拒收（实测 108ms 返回、流里一个字节都没有，
   表现为"空回复"，接着 5 次重试全废 —— 工具闸门等于从来没生效过）。
   `sanitizeForTwin()` 给未执行的调用补一条"（该调用尚未执行：这一步正在审查，还没有结果）"。
2. **绝不能往会话里写任何东西**。插一条消息（哪怕只是给用户看的一行通知）就会让这条会话
   **从此每个回合都 400 报错、彻底读不出来**：
   `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.`
   所以监察记录 / 固定文本 / 中断回合都先排队，等这一步的工具结果落盘（`step/end`）再一起执行。

症状对照：日志里出现 `监察不可用（已重试 5 次）：空回复` → 看第 1 条；
某个会话打不开或每轮报上面那句 400 → 看第 2 条（`_dev/check_pairing.cjs <session-id>` 能直接定位坏序列）。

## 什么时候审（闸门触发规则）

1. 该动作前面**不是同类动作**（链首 / 类型切换）→ 必审；
2. 前面是同类动作 → 距上次审查 **≥10 次动作** 或 **≥10 分钟** → 审；
3. 都不满足 → 跳过；预算用尽或本回合已提过两次意见 → 静默跳过。

实测（8 个真实会话、3267 次工具动作）：审查总数与参照算法逐条一致，
工具覆盖率约 10.6%，每回合约 3 次审查。

## 判据：插件自带的 `criteria.json`

```json
{ "version": 1, "role": "…", "contract": "…", "usage": "…",
  "items": [ { "id": 1, "when": "什么时候查这一条", "q": "要检查什么" } ] }
```

- 一条判据一个条目、各自带**使用场景**（`when`），不按来源技能分组；
- 全部用最普通的话写、不用比喻与行话、一律写成"要求做某事"；
- **不装载任何技能文件**：技能带的是执行者的触发条件与做法，监察要的是判据，视角不对。

改措辞不必动代码：把覆盖文件放 `~/.dsh/liubian-twin/criteria.json` 即优先于插件自带那份。

## 配置 `~/.dsh/liubian-twin/config.json`

```js
// ── 闸门触发 ──
twinChainHeadAlways: true,     // 规则①：链首 / 类型切换必审
twinGapCalls: 10,              // 规则②：距上次审查 ≥N 次动作
twinGapMinutes: 10,            // 规则②：距上次审查 ≥N 分钟
twinMaxReviewsPerTurn: 12,     // 每回合审查预算（用尽静默跳过）
// ── 送监内容 ──
twinCriteria: '',              // 判据 JSON 路径（空 = 用覆盖文件，再退回插件自带）
twinPrompt: '',                // 备用：额外的角色文字（一般直接改 criteria.json）
twinContextMode: 'flatten',    // 'flatten' 拍平最近若干轮 | 'isolated' 只带最近一条 | 'full' 整段对话 | 'none' 不给背景
twinTranscriptRounds: 10,      // 拍平最近多少轮（一轮 = 人类发言 + 其后动作/工具往返）
twinRoundChars: 0,             // 每轮字数上限（0 = 不限；正文与用户输入不设限）
twinBackgroundChars: 0,        // 全局上限（0 = 不限）
twinIncludeTools: false,       // 是否把工具调用/工具结果也拍进背景（默认丢掉）
twinIncludeReasoning: true,    // 是否把模型的思考也拍进去
twinStripMarkers: true,        // 清掉全角竖线 / ▁ / 思考阶段标记等特殊标识符
twinForge: true,               // 结构伪造：指令后再递一条"思考已结束"的助手消息（只发不写会话）
twinForgeReasoning: '（判据已逐条对照完毕，下面直接给结论。）',
twinForgeContent: '',
twinPrefill: '',               // 纯文本尾巴（老做法，默认关）
// ── 超时与失败 ──
twinIdleTimeoutMs: 5000,       // 两次输出之间的空档超过这么久才算超时（不掐思考耗时）
twinTimeoutMs: 300000,         // 单次审查的绝对上限（兜底）
twinRetryDelayMs: 5000,        // 失败后重试间隔
twinRetryMax: 5,               // 最多重试次数
twinUnavailableText: '监察api不可用，请尝试关闭插件或者稍后尝试',
```

监察模型**固定用会话自己那个**（`session.requestContext()`），不提供切换开关。

### 两处硬约束（踩过事故，改动时别绕开）

1. **送监请求必须先补占位工具结果**：工具闸门被调用时，`deriveMessages()` 的尾巴是"assistant 已发
   tool_calls、结果未落盘"，直接送上游必被拒收（表现为"空回复"）。`sanitizeForTwin()` 负责补。
2. **落盘前必须过配对检查**：`pairingOk()` 要求每条 assistant 的每个 tool-call 后面**紧跟**一段连续的
   工具结果把它覆盖；不满足就推迟重试（1.5s × 5），到上限宁可丢弃记录也不写。
   会话写入（监察记录 / 固定文本 / 中断回合）一律排队到 `step/end` 再落。

## 开发

```bash
node --check lib/impl.mjs
node _dev/stub_test.mjs     # 22 项桩测：判据 / 指令 / 解析 / 触发规则 / 文本闸门五契约 / 工具闸门 / 送监形态
node _dev/gate_sim.mjs      # 闸门规则在真实会话上的复算与对账
node _dev/check_pairing.cjs <session-id>   # 查会话日志里有没有坏序列（tool_calls 没配上结果）
node _dev/scan_sessions.cjs                # 全库扫孪生留下的痕迹
```

改 `lib/impl.mjs` 后热注入即生效（入口壳用 `?t=<时间戳>` 绕开 ESM 缓存）；
只有改 `name` / `inject` 才需要重启 DSH。

## 已知限制

1. 同模型孪生独立性弱：执行在自己的推理里已经"自我同意"过一遍，换角色属弱校验
   （判"是否符合用户指令"尚可，判"执行想不到的错"收益有限）。
2. 闸门是停等的：文本闸门让答案不再逐字流式（"思考流 → 停顿 → 整段出现"），每回合几次可感知停顿。
3. 最坏情形：监察 API 持续失败 → 工具闸门把回合冻住约 25 秒（5s × 5）再中断。
4. 长任务执行期间不可能被检查点打断——止损点最早是它**返回之后**的第一次审查。
5. 误拦防线 = 预算 + 未解决出口（提两次意见后停止继续审）+ 角色里的证据要求。
