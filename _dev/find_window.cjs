#!/usr/bin/env node
/**
 * 一次性诊断脚本（_dev 专用）：扫全库会话，找出在给定时间窗内有记录的那些，
 * 用于定位某次运行时事故发生在哪个会话里。
 *
 * 用法: node find_window.cjs <fromMs> <toMs>
 */
const fs = require('fs')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const from = Number(process.argv[2])
const to = Number(process.argv[3])
const root = path.join(process.env.DSH_HOME || path.join(require('os').homedir(), '.dsh'), 'sessions')

for (const ws of fs.readdirSync(root)) {
  const wsDir = path.join(root, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    let text = ''
    try { text = dec.decodeSessionFile(f).text } catch { continue }
    const recs = text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const hit = recs.filter(r => typeof r.time === 'number' && r.time >= from && r.time <= to)
    if (hit.length) {
      console.log(`${s}  ws=${ws}  窗口内记录=${hit.length}`)
      hit.slice(0, 6).forEach(r => console.log(`    #${recs.indexOf(r)} ${new Date(r.time).toISOString().slice(11, 23)} ${r.type}`))
    }
  }
}
