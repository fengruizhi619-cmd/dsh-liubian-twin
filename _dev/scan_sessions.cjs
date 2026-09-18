#!/usr/bin/env node
/**
 * 一次性诊断脚本（_dev 专用，不属于插件产物）：
 * 在全库会话日志里找孪生监察留下的痕迹，并打印命中会话的最后若干条记录，
 * 用来确认「assistant(tool_calls) 后面没有 tool 结果」这个坏序列是谁写进去的。
 *
 * 用法: node scan_sessions.cjs [关键字...]     默认关键字：监察api不可用 / 孪生监察 / 〔监察〕
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const zlib = require('zlib')

const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions')
const NEEDLES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['监察api不可用', '孪生监察', '〔监察〕', '_twin_note']

function frameLength(b, off) {
  let p = off
  const magic = b.readUInt32LE(p)
  if ((magic & 0xffffffF0) === 0x184d2a50) return 8 + b.readUInt32LE(p + 4)
  if (magic !== 0xfd2fb528) throw new Error('not zstd frame at ' + off)
  p += 4
  const fhd = b[p]; p += 1
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (!singleSegment) p += 1
  p += [0, 1, 2, 4][dictFlag]
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [2, 4, 8][fcsFlag - 1]
  for (;;) {
    const bh = b.readUInt32LE(p) & 0xffffff
    const last = bh & 1
    const btype = (bh >> 1) & 3
    const bsize = (bh >> 3) & 0x1fffff
    p += 3
    if (btype === 0) p += bsize
    else if (btype === 1) p += 1
    else if (btype === 2) p += bsize
    else throw new Error('reserved block')
    if (last) break
  }
  if (checksum) p += 4
  return p - off
}

function decode(file) {
  const buf = fs.readFileSync(file)
  const parts = []
  let off = 0
  while (off < buf.length - 3) {
    const len = frameLength(buf, off)
    if ((buf.readUInt32LE(off) & 0xffffffF0) !== 0x184d2a50) {
      parts.push(zlib.zstdDecompressSync(buf.subarray(off, off + len)).toString('utf8'))
    }
    off += len
  }
  return parts.join('')
}

function records(text) {
  return text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const hits = []
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    const st = fs.statSync(f)
    if (st.mtime < new Date('2026-09-18T22:00:00')) continue
    let text = ''
    try { text = decode(f) } catch (e) { console.log('DECODE FAIL', s, e.message); continue }
    const found = NEEDLES.filter(n => text.includes(n))
    if (found.length) hits.push({ ws, s, f, text, found, bytes: st.size })
  }
}

console.log('命中会话数:', hits.length)
for (const h of hits) {
  const recs = records(h.text)
  console.log('\n==== ' + h.s + '  ws=' + h.ws + '  records=' + recs.length + '  needles=' + h.found.join(',') + '  size=' + (h.bytes / 1048576).toFixed(1) + 'MB')
  for (const n of h.found) {
    const idx = recs.findIndex(r => JSON.stringify(r).includes(n))
    console.log('  first hit of "' + n + '" at record #' + idx)
  }
  const tail = recs.slice(-40)
  console.log('  --- last ' + tail.length + ' records ---')
  tail.forEach((r, i) => {
    const s = JSON.stringify(r)
    console.log('  [' + (recs.length - tail.length + i) + '] ' + (s.length > 420 ? s.slice(0, 420) + '…' : s))
  })
}
