#!/usr/bin/env node
/**
 * lib/client.js 的启动自检（不依赖宿主、不依赖真 React）。
 *
 *   node _dev/verify_client_boot.mjs
 *
 * 验什么：① client.js 能被 __ModuleLoader__ 装载；② apply 后向 conversation.view
 * 注册了「孪生」页签（id twin / label 孪生 / inject 函数在位）；③ 页签组件在
 * 「拿到 sessionId」与「拿不到 sessionId」两种 props 下都不炸——拿不到时必须显示
 * 预登记的降级提示（v3 文档 §4 的未验证点），不许装作正常。
 * 另验 package.json 的客户端清单三件：./client 导出、dsh.client 段、版本同步。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const results = []
function check(name, fn) {
  try { fn(); results.push(`PASS  ${name}`) } catch (err) {
    results.push(`FAIL  ${name}\n      ${(err && err.message) || err}`)
    process.exitCode = 1
  }
}

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// ── 桩 React：只实现 client.js 用到的三个入口；createElement 记录树以便断言文本。
function makeReact() {
  const calls = []
  const R = {
    calls,
    createElement(type, props, ...children) {
      const node = { type, props: props || {}, children: children.flat().filter(c => c !== null && c !== undefined) }
      calls.push(node)
      return node
    },
    useState: (init) => [init, () => {}],
    useEffect: () => {},
  }
  return R
}
/** 收集元素树里的全部文本。 */
function collectTexts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) collectTexts(c, out); return out }
  if (node.children) for (const c of node.children) collectTexts(c, out)
  return out
}

let loaded = null
const fakeWindow = { __ModuleLoader__: { load(def) { loaded = def } } }
new Function('window', src)(fakeWindow)

check('装载：client.js 通过 __ModuleLoader__.load 注册，id = 包名', () => {
  assert.ok(loaded, '__ModuleLoader__.load 没被调用')
  assert.equal(loaded.id, 'dsh-liubian-twin')
  assert.equal(typeof loaded.factory, 'function')
})

const React = makeReact()
const mod = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`client.js 意外 require：${name}`)
})

check('清单：package.json 声明 ./client 导出 + dsh.client 段 + 版本与 impl 同步', () => {
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  // 2026-10-03 事故：inject 漏了 dsh-client-runtime → 冷启动时 window.__ModuleLoader__
  // 尚不存在，client 模块求值即死、页签消失（热挂载时 runtime 已被别的插件带起来，
  // 所以"打开时有、重启后没"）。kotatsu/notes 两个冷启动正常样本都是 runtime + conversation 双声明。
  for (const pkgName of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation']) {
    assert.ok(pkg.dsh.client.inject.includes(pkgName), `dsh.client.inject 缺 ${pkgName}`)
  }
  const implSrc = readFileSync(new URL('../lib/impl.mjs', import.meta.url), 'utf8')
  const m = implSrc.match(/PLUGIN_VERSION = '([\d.]+)'/)
  assert.ok(m, 'impl.mjs 里有 PLUGIN_VERSION')
  assert.equal(pkg.version, m[1], `package.json=${pkg.version} impl=${m[1]}`)
})

check('exports 放行 ./package.json：宿主读清单的那条 resolve 必须真通（2026-10-03 第二击）', () => {
  // dsh-client-modules 的 resolveMeta 用 createRequire(入口).resolve('<包名>/package.json')
  // 读插件清单（lib/index.js L756）。exports 一旦收窄（加 ./client 时忘了放行 ./package.json），
  // 这条 resolve 抛 ERR_PACKAGE_PATH_NOT_EXPORTED → client 半被静默当"不存在"→ 页签消失。
  // 这里按宿主的调用形状，走 **profile junction** 真解析一次（不是只查字符串）。
  const profileDir = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop')
  const entry = join(resolve(profileDir), 'node_modules', 'dsh-liubian-twin', 'lib', 'main.mjs')
  assert.ok(readFileSync(entry, 'utf8').length > 0, `junction 入口可读：${entry}`)
  const req = createRequire(entry)
  let resolved = ''
  try {
    resolved = req.resolve('dsh-liubian-twin/package.json')
  } catch (e) {
    assert.fail(`宿主同款 resolve 失败：${e.code || ''} ${String(e.message).split('\n')[0]}——exports 必须放行 ./package.json`)
  }
  const j = JSON.parse(readFileSync(resolved, 'utf8'))
  assert.equal(j.name, 'dsh-liubian-twin')
  assert.ok(j.dsh?.client, '解析到的清单必须带 dsh.client')
})

check('入口 inject 声明：main.mjs 必须含 webServer（2026-10-03 事故的静态护栏）', () => {
  const mainSrc = readFileSync(new URL('../lib/main.mjs', import.meta.url), 'utf8')
  const m = mainSrc.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(m, 'main.mjs 里有静态 inject 数组')
  const declared = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  for (const svc of ['webServer', 'tools', 'llm', 'agents']) {
    assert.ok(declared.includes(svc), `inject 缺 '${svc}'——未声明的宿主服务在 apply 里访问即抛，整个插件会装配失败（含 client 半）`)
  }
  // 面板挂载必须自带兜底与 try/catch：面板是附属品，绝不连坐闸门。
  const implSrc2 = readFileSync(new URL('../lib/impl.mjs', import.meta.url), 'utf8')
  assert.ok(implSrc2.includes("ctx.reflect?.get?.('webServer')"), 'mountTwinPanel 要有 reflect 兜底（inject 未生效的窗口期/热注入场景）')
})

check('apply：向 conversation.view 注册「孪生」页签，effect 带清理', () => {
  assert.deepEqual(mod.inject, ['slots'])
  let injectCalls = 0
  let injectDisposed = 0
  const slots = {
    inject(key, cb) {
      injectCalls++
      assert.equal(key, 'conversation.view')
      const reg = cb()
      assert.equal(typeof reg, 'function', 'register 返回去注册函数')
      return () => { injectDisposed++ }
    },
    register(options, component) {
      assert.equal(options.name, 'conversation.view')
      assert.equal(options.id, 'twin')
      assert.equal(options.label, '孪生', '管理员定案：名称取为孪生')
      assert.equal(options.order, 20)
      assert.equal(typeof options.inject, 'function')
      assert.equal(typeof component, 'function', 'occupant 必须是组件（不做 trajectory 式自定义视图管线）')
      return () => {}
    },
  }
  // ctx.effect 的契约（🔴-8 教训）：fn 立即执行、fn 的返回值作为清理函数。
  let effectCleanup = null
  const ctx = { effect(fn) { effectCleanup = fn(); return effectCleanup }, slots }
  mod.apply(ctx)
  assert.equal(injectCalls, 1)
  assert.equal(typeof effectCleanup, 'function', 'effect 的 fn 必须返回 slots.inject 的去注册函数（宿主卸载时摘页签）')
  effectCleanup()
  assert.equal(injectDisposed, 1, '清理要真的摘下页签注册')
})

const slotsForRender = {
  inject(key, cb) { cb(); return () => {} },
  register(options, component) { lastRegistration = { options, component }; return () => {} },
}
let lastRegistration = null
{
  const ctx = { effect(fn) { return fn() }, slots: slotsForRender }
  mod.apply(ctx)
}

check('inject(sessionId) 返回值带会话 id（组件取 sessionId 的正路）', () => {
  assert.equal(lastRegistration.options.inject('session-abc').twinSessionId, 'session-abc')
})

check('组件·拿到 sessionId → 渲染不炸（loading 态）', () => {
  const el = lastRegistration.component({ twinSessionId: 'session-abc' })
  assert.ok(el, '要返回元素')
  const texts = collectTexts(el)
  assert.ok(texts.some(t => t.includes('加载中')), `loading 态要有提示；实际文本：${JSON.stringify(texts)}`)
})

check('组件·拿不到 sessionId → 显示预登记的降级提示，不装作正常', () => {
  const el = lastRegistration.component({})
  assert.ok(el, '要返回元素')
  const texts = collectTexts(el)
  assert.ok(texts.some(t => t.includes('无法定位当前会话')), `要有降级提示；实际文本：${JSON.stringify(texts)}`)
  assert.ok(texts.some(t => t.includes('未实证')), '提示要点名这是预登记未验证点')
})

console.log(results.join('\n'))
console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} 通过`)
