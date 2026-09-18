#!/usr/bin/env node
/**
 * 一次性诊断脚本（_dev 专用）：按**时间窗**打印会话日志的全部记录
 * （不筛类型，连 inbox/notice/事件都打出来），用来复盘孪生那几十秒做了什么。
 *
 * 用法: node dump_window.cjs <session-id> <fromMs> <toMs> [关键字]
 *   时间戳 = 毫秒 epoch（日志里的 time 字段）
 */
const fs = require('fs')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

function resolveFile(arg) {
  if (fs.existsSync(arg)) return arg
  const root = path.join(process.env.DSH_HOME || path.join(require('os').homedir(), '.dsh'), 'sessions')
  for (const ws of fs.readdirSync(root)) {
    const wsDir = path.join(root, ws)
    if (!fs.statSync(wsDir).isDirectory()) continue
    for (const s of fs.readdirSync(wsDir)) {
      if (!s.includes(arg)) continue
      const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
      if (fs.existsSync(f)) return f
    }
  }
  throw new Error('找不到会话: ' + arg)
}

const file = resolveFile(process.argv[2])
const from = Number(process.argv[3])
const to = Number(process.argv[4])
const needle = process.argv[5] || ''
const { text } = dec.decodeSessionFile(file)
const recs = text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
console.log('文件:', file, '| 记录数:', recs.length, '| 窗口:', new Date(from).toISOString(), '→', new Date(to).toISOString())
let n = 0
recs.forEach((r, i) => {
  if (typeof r.time !== 'number' || r.time < from || r.time > to) return
  const raw = JSON.stringify(r)
  if (needle && !raw.includes(needle)) return
  n++
  console.log(`#${i} seq=${r.seq} ${new Date(r.time).toISOString().replace('T', ' ').slice(0, 23)} ${r.type}  ${clip(JSON.stringify(r.data || {}), 700)}`)
})
console.log('命中记录:', n)
