/**
 * 直接把手改过的送监上下文发给上游，**把原始流 print 出来**（看得见每个分块）。
 * 不依赖 DSH：只用一个 key + base_url + model。
 *
 *   node _dev/send_context.cjs --key <KEY> --base-url <URL> --model deepseek-flash \
 *        [--messages _dev/ctx/wire.json] [--idle-ms 5000] [--max-tokens 8000] \
 *        [--reasoning-effort low] [--out _dev/ctx/reply.txt] [--raw]
 *
 * 说明：
 *   --messages 默认读 _dev/ctx/wire.json（dump_context.cjs 的产物，可直接手改）
 *   --idle-ms  两次分块之间的最大空档，超了就断开（默认 5000）
 *   --raw      把每个分块的原始 JSON 也打出来
 *   --stream false  改成一次性请求（默认流式）
 */
process.noAsar = true
const fs = require('fs')
const path = require('path')

function argOf(name, dflt) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

const key = argOf('key', process.env.DEEPSEEK_API_KEY || '')
const baseUrl = String(argOf('base-url', 'https://api.deepseek.com/v1')).replace(/\/+$/, '')
const model = String(argOf('model', 'deepseek-flash'))
const messagesPath = path.resolve(__dirname, String(argOf('messages', path.join(__dirname, 'ctx', 'wire.json'))))
const idleMs = Number(argOf('idle-ms', 5000))
const maxTokens = Number(argOf('max-tokens', 0)) || undefined
const reasoningEffort = argOf('reasoning-effort', '')
const outPath = argOf('out', '')
const raw = Boolean(argOf('raw', false))
const stream = argOf('stream', 'true') !== 'false'

if (!key) {
  console.error('缺 key：--key <API_KEY>（或设环境变量 DEEPSEEK_API_KEY）')
  process.exit(2)
}
if (!fs.existsSync(messagesPath)) {
  console.error('找不到消息文件：', messagesPath, '——先跑 node _dev/dump_context.cjs')
  process.exit(2)
}
const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'))
const body = { model, messages, stream }
if (maxTokens) body.max_tokens = maxTokens
if (reasoningEffort) body.reasoning_effort = reasoningEffort

console.log('POST', baseUrl + '/chat/completions')
console.log('model =', model, '| messages =', messages.length, '| stream =', stream, '| idle 上限 =', idleMs, 'ms')
const roles = {}
for (const m of messages) roles[m.role] = (roles[m.role] || 0) + 1
console.log('角色计数 =', JSON.stringify(roles))
const last = messages[messages.length - 1] || {}
console.log('末尾一条 =', last.role, JSON.stringify(String(last.content || '').slice(-160)))
console.log('--- 流开始 ---')

const ac = new AbortController()
let idleTimer = null
const armIdle = () => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { console.log(`\n[本地断开] 连续 ${idleMs}ms 没有新分块`); ac.abort(new Error('idle')) }, idleMs)
}
armIdle()

let reasoning = ''
let text = ''
let rawDump = []

async function run() {
  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: ac.signal,
  })
  if (!res.ok) {
    console.log('[HTTP]', res.status, (await res.text()).slice(0, 600))
    return
  }
  if (!stream) {
    const json = await res.json()
    console.log(JSON.stringify(json, null, 1).slice(0, 4000))
    return
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    armIdle()
    buf += dec.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') { console.log('\n[DONE]'); continue }
      let json
      try { json = JSON.parse(payload) } catch { continue }
      if (raw) rawDump.push(json)
      const delta = json.choices && json.choices[0] && json.choices[0].delta
      if (!delta) continue
      if (delta.reasoning_content) { reasoning += delta.reasoning_content; process.stdout.write(delta.reasoning_content) }
      if (delta.content) { text += delta.content; process.stdout.write(delta.content) }
      if (json.choices[0].finish_reason) console.log('\n[finish_reason]', json.choices[0].finish_reason)
      if (json.usage) console.log('\n[usage]', JSON.stringify(json.usage))
    }
  }
}

run()
  .catch(err => console.log('\n[异常]', (err && err.message) || err))
  .finally(() => {
    if (idleTimer) clearTimeout(idleTimer)
    console.log('\n--- 流结束 ---')
    console.log('思考:', reasoning.length, '字 | 正文:', text.length, '字')
    console.log('正文前 200 字:', JSON.stringify(text.slice(0, 200)))
    // 结论词认没认出来，用插件自己的解析器判一次
    import(new URL('../lib/impl.mjs', `file:///${__filename.replace(/\\/g, '/')}`).href)
      .then(m => {
        const v = m.parseVerdict(text)
        console.log('解析结果:', v.ok ? `ok conform=${v.verdict.conform}` : `失败 ${v.error}`)
      })
      .catch(() => {})
    if (outPath) {
      const p = path.resolve(__dirname, String(outPath))
      fs.writeFileSync(p, JSON.stringify({ reasoning, text, raw: rawDump }, null, 1), 'utf8')
      console.log('已写出:', p)
    }
  })
