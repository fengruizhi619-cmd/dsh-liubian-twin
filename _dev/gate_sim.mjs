/**
 * 闸门触发规则实测复算：把 8 个真实会话的动作序列喂给**插件里真正在跑的那套记账**
 * （impl.mjs 的 peekReview / shouldReview / markReviewed / resetTurn），
 * 与实施方案 §2.3 的基线数字对账。
 *
 *   node _dev/gate_sim.mjs
 *
 * 基线（同口径、独立脚本 _recovery/gate_policy_sim.cjs 得出）：
 *   工具调用 2952 / 文本 136 / 链首触发 216 / 次数间隔 246 / 时间间隔 6
 *   审查总数 468（工具 354 + 文本 114）、覆盖率 12.0%、每回合约 4.3 次。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
process.noAsar = true
const { decodeSessionFile } = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const m = await import(new URL('../lib/impl.mjs', import.meta.url).href)
const T = m.__test
const cfg = { ...T.DEFAULTS, twinMaxReviewsPerTurn: 999 } // 复算时先摘掉预算，单看规则本身

const files = []
;(function walk(dir, d = 0) {
  if (d > 4) return
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, d + 1)
    else if (e.name.endsWith('.zstd')) { const st = fs.statSync(p); files.push({ p, size: st.size, mtime: st.mtimeMs }) }
  }
})('C:/Users/Feng/.dsh/sessions')
files.sort((a, b) => b.mtime - a.mtime)
const pick = files.filter(f => f.size > 20_000 && f.size < 12_000_000).slice(0, 8)

const T0 = { calls: 0, texts: 0, reviews: 0, onCalls: 0, onTexts: 0, head: 0, byCalls: 0, byTime: 0, chains: 0, turns: 0 }
const byWhy = {}
const REF = { reviews: 0, head: 0, byCalls: 0, byTime: 0, onCalls: 0 }
const REAL = { reviews: 0, onCalls: 0, turns: 0, budgetSkips: 0 }
const perTurn = []

/** 参照算法：_recovery/gate_policy_sim.cjs 的原始逻辑（按会话、不重置回合）。 */
function referencePass(actions) {
  let lastReviewIdx = -1
  let lastReviewTime = 0
  let prevKind = null
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    const sameKind = prevKind === a.kind
    let review = false
    let why = ''
    if (!sameKind) { review = true; why = 'head' }
    else {
      const callGap = i - lastReviewIdx
      const timeGap = a.time && lastReviewTime ? a.time - lastReviewTime : 0
      if (callGap >= 10) { review = true; why = 'byCalls' }
      else if (timeGap >= 10 * 60 * 1000) { review = true; why = 'byTime' }
    }
    prevKind = a.kind
    if (review) {
      REF.reviews += 1
      if (why === 'head') REF.head += 1
      if (why === 'byCalls') REF.byCalls += 1
      if (why === 'byTime') REF.byTime += 1
      if (a.kind === 'tool') REF.onCalls += 1
      lastReviewIdx = i
      lastReviewTime = a.time || 0
    }
  }
}

for (const f of pick) {
  let text
  try { text = decodeSessionFile(f.p).text } catch { continue }
  const evs = []
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { evs.push(JSON.parse(l)) } catch {} }

  // 收集动作（与参照脚本同口径：有工具调用的步只算工具动作）
  const actions = []
  const turns = []
  let turn = 0
  for (const e of evs) {
    if (!e) continue
    if (e.type === 'turn/start') { turn = e.data?.turn ?? turn + 1; turns.push(actions.length); continue }
    if (e.type !== 'assistant/message') continue
    const msg = (e.data && e.data.message) || {}
    const content = Array.isArray(msg.content) ? msg.content : []
    const calls = content.filter(b => b && b.type === 'tool-call')
    const texts = content.filter(b => b && b.type === 'text')
    const t = Number(e.time) || 0
    for (const _ of calls) actions.push({ kind: 'tool', time: t })
    if (calls.length === 0) for (const _ of texts) actions.push({ kind: 'text', time: t })
  }
  if (!actions.length) continue

  referencePass(actions)

  // 我的实现（同一批动作、摘掉回合重置 → 应与参照算法逐次一致）
  const stA = T.makeState()
  for (const a of actions) {
    if (a.kind === 'tool') T0.calls += 1
    else T0.texts += 1
    const d = T.shouldReview(stA, cfg, a.kind, a.time || Date.now())
    if (d.review) {
      T0.reviews += 1
      byWhy[d.why] = (byWhy[d.why] || 0) + 1
      if (a.kind === 'tool') T0.onCalls += 1
      else T0.onTexts += 1
      if (d.why === 'chain-head' || d.why === 'kind-switch') T0.head += 1
      if (d.why === 'gap-calls') T0.byCalls += 1
      if (d.why === 'gap-time') T0.byTime += 1
      T.markReviewed(stA, a.time || Date.now())
    }
  }

  // 真实运行姿态：带回合重置 + 预算上限
  const stB = T.makeState()
  const realCfg = { ...T.DEFAULTS }
  let idx = 0
  let ti = 0
  let curTurn = 0
  let turnCandidates = 0
  let turnReviews = 0
  for (const a of actions) {
    if (ti < turns.length && turns[ti] <= idx) {
      if (curTurn > 0) { perTurn.push({ turn: curTurn, candidates: turnCandidates, reviews: turnReviews }) }
      curTurn += 1
      T.resetTurn(stB, curTurn)
      REAL.turns += 1
      turnCandidates = 0
      turnReviews = 0
      while (ti < turns.length && turns[ti] <= idx) ti += 1
    }
    const peek = T.peekReview(stB, realCfg, a.kind)
    if (peek.review) turnCandidates += 1
    const d = T.shouldReview(stB, realCfg, a.kind, a.time || Date.now())
    if (d.review) {
      REAL.reviews += 1
      turnReviews += 1
      if (a.kind === 'tool') REAL.onCalls += 1
      T.markReviewed(stB, a.time || Date.now())
    } else if (d.why === 'budget') REAL.budgetSkips += 1
    idx += 1
  }
  if (curTurn > 0) perTurn.push({ turn: curTurn, candidates: turnCandidates, reviews: turnReviews })
}

const pct = T0.calls ? ((T0.onCalls / T0.calls) * 100).toFixed(1) : '0'
console.log('会话数          :', pick.length)
console.log('动作            : 工具', T0.calls, '文本', T0.texts)
console.log('')
console.log('—— 对账：参照算法 vs 本插件实现（同批动作、都不做回合重置）——')
console.log('  参照 审查总数 :', REF.reviews, '| 链首', REF.head, '| 次数间隔', REF.byCalls, '| 时间间隔', REF.byTime, '| 工具被审', REF.onCalls)
console.log('  实现 审查总数 :', T0.reviews, '| 链首+切换', T0.head, '| 次数间隔', T0.byCalls, '| 时间间隔', T0.byTime, '| 工具被审', T0.onCalls)
console.log('  一致          :', REF.reviews === T0.reviews && REF.head === T0.head && REF.byCalls === T0.byCalls && REF.byTime === T0.byTime ? 'YES' : 'NO')
console.log('')
console.log('—— 真实姿态（回合重置 + 预算 8/回合）——')
console.log('  回合数        :', REAL.turns)
console.log('  审查总数      :', REAL.reviews)
console.log('  工具覆盖率    :', `${T0.calls ? ((REAL.onCalls / T0.calls) * 100).toFixed(1) : '0'}%`)
console.log('  每回合审查    :', REAL.turns ? (REAL.reviews / REAL.turns).toFixed(2) : '-')
console.log('  预算拦截次数  :', REAL.budgetSkips)
const active = perTurn.filter(t => t.candidates > 0)
const over = active.filter(t => t.candidates > 8)
console.log('  有动作的回合  :', active.length, `（候选 >8 的回合 ${over.length} 个）`)
console.log('  单回合候选数  : 最大', Math.max(0, ...active.map(t => t.candidates)), '| 中位', active.length ? active.map(t => t.candidates).sort((a, b) => a - b)[Math.floor(active.length / 2)] : 0)
console.log('  触发原因分布  :', JSON.stringify(byWhy))

