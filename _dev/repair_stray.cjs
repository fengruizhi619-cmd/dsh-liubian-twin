/**
 * repair_stray2.cjs — 清掉"步外助手消息"（宿主的 token meter 会对它抛
 *   assistant/message at seq N has no matching step/start event，
 * 让 basic-compaction-engine 每次压缩都失败）。
 *
 * 与旧版 repair_stray.cjs 的差别（这版更保守）：
 *   1. 第 0 帧**按字节原样保留**（只重打包正文帧）——旧版把"第 0 帧"当成一行 header 重写，
 *      一旦第 0 帧里还有事件就会丢/重。本版发现第 0 帧不是恰好一行就拒绝动手。
 *   2. 断链门：若待删的 assistant 消息里带 tool-call，或它的 seq 被任何 tool/result 引用，直接拒绝。
 *   3. 未删记录**逐字节保留原行**（只重编 seq 数字），减少无谓 diff。
 *   4. 只扫正文帧，不把文件尾的撕裂帧算进记录数（旧版会把只解出部分帧的文件误判）。
 *
 *   node repair_stray2.cjs --dry                # 全量扫描，只报告
 *   node repair_stray2.cjs 10fa85f7 --dry       # 指定会话片段
 *   node repair_stray2.cjs 10fa85f7 --apply     # 备份后原子替换
 *   node repair_stray2.cjs --all --apply        # 全部（自动跳过当前会话）
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('node:zlib')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const all = args.includes('--all')
const reseq = args.includes('--reseq')
const frag = args.find(a => !a.startsWith('--')) || null
const SELF = process.env.DSH_SESSION_ID || null

/* ── zstd 多帧读取（按帧头 + block 头精确算帧长）───────────────────────────── */
function frameLength(b, off) {
  let p = off
  const magic = b.readUInt32LE(p)
  if ((magic & 0xffffffF0) === 0x184d2a50) return 8 + b.readUInt32LE(p + 4)
  if (magic !== 0xfd2fb528) throw new Error('不是 zstd 帧 @' + off)
  p += 4
  const fhd = b[p]; p += 1
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dict = fhd & 3
  if (!single) p += 1
  p += [0, 1, 2, 4][dict]
  p += fcsFlag === 0 ? (single ? 1 : 0) : [2, 4, 8][fcsFlag - 1]
  for (;;) {
    const bh = b.readUInt32LE(p) & 0xffffff
    const last = bh & 1, btype = (bh >> 1) & 3, bsize = (bh >> 3) & 0x1fffff
    p += 3
    if (btype === 0) p += bsize
    else if (btype === 1) p += 1
    else if (btype === 2) p += bsize
    else throw new Error('保留 block')
    if (last) break
  }
  if (checksum) p += 4
  return p - off
}
/** 返回 [{off,len}...]；尾部撕裂（不足一个完整帧）报 torn */
function scanFrames(b) {
  const out = []
  let off = 0
  while (off < b.length) {
    if (b.length - off < 4) return { frames: out, torn: off }
    try {
      const len = frameLength(b, off)
      if (off + len > b.length) return { frames: out, torn: off }
      out.push({ off, len })
      off += len
    } catch (e) { return { frames: out, torn: off } }
  }
  return { frames: out, torn: null }
}
const dec = b => zlib.zstdDecompressSync(b).toString('utf8')

/* ── 待修判据 ─────────────────────────────────────────────────────────────── */
function findStrays(recs) {
  const openSteps = new Set()
  const stray = new Set()
  const why = new Map()
  for (const r of recs) {
    const key = `${r.obj.data && r.obj.data.turn}/${r.obj.data && r.obj.data.step}`
    if (r.obj.type === 'step/start') { openSteps.add(key); continue }
    if (r.obj.type === 'step/end') { openSteps.delete(key); continue }
    if (r.obj.type !== 'assistant/message') continue
    const d = r.obj.data || {}
    if (d.turn === 999 && d.step === 1) { stray.add(r); why.set(r, 'turn=999 自检指纹'); continue }
    if (!openSteps.has(key)) { stray.add(r); why.set(r, `步外助手消息（turn ${d.turn} step ${d.step} 无 open step）`) }
  }
  return { stray, why }
}

function fixOne(file, { quiet = false } = {}) {
  const buf = fs.readFileSync(file)
  const { frames, torn } = scanFrames(buf)
  if (torn !== null) throw new Error('文件尾有撕裂帧 @' + torn + '，先别动它')
  if (frames.length < 2) throw new Error('帧数 < 2，不是 v3 会话日志')
  const f0 = dec(buf.subarray(frames[0].off, frames[0].off + frames[0].len))
  if (f0.indexOf('\n') !== f0.length - 1 || f0.split('\n').filter(l => l.trim()).length !== 1) {
    throw new Error('第 0 帧不是恰好一行会话头，本工具拒绝动手（需人工处理）')
  }
  const headerLine = f0.slice(0, -1)
  const headerObj = JSON.parse(headerLine)
  if (headerObj.type !== 'session') throw new Error('第 0 帧首行不是 session 记录')

  const recs = []
  for (let fi = 1; fi < frames.length; fi++) {
    const text = dec(buf.subarray(frames[fi].off, frames[fi].off + frames[fi].len))
    if (text && text[text.length - 1] !== '\n') throw new Error('正文帧 ' + fi + ' 未以换行收尾')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let obj
      try { obj = JSON.parse(line) } catch (e) { throw new Error('帧 ' + fi + ' 有非 JSON 行：' + e.message) }
      if (obj && obj.type === 'session') continue // 会话头（第 0 帧首行，按类型认而不是按帧认）
      recs.push({ line, obj, frame: fi })
    }
  }
  const { stray, why } = findStrays(recs)

  // 闸门：seq 断档 = 有别的写入方按它自己的计数在往这个文件追加（宿主还开着这条会话）。
  // 此时重写只是白修（对方下一次 append 又会按旧计数写回来），先报出来。
  const gap = recs.findIndex((r, i) => r.obj.seq !== i)
  if (gap >= 0) {
    const r = recs[gap]
    console.log('  ⚠ seq 断档 @记录#' + gap + '（seq=' + r.obj.seq + '，记录数=' + recs.length + '）——还有写入方开着这条会话；')
    console.log('    先在 DSH 里关掉/重启让它重新加载，再跑本工具，否则修了也会被写回。')
    if (!reseq) return { file, changed: 0, recs: recs.length, blocked: 'seq-gap' }
    console.log('    --reseq：按记录顺序重编 seq（宿主已写入的内容一条不丢）。')
  }

  if (!stray.size && gap < 0) return { file, changed: 0, recs: recs.length }

  // 断链门 1：待删记录里带 tool-call 就不许删（会让配对的 tool 结果变成孤儿）
  for (const r of stray) {
    const blocks = Array.isArray(r.obj.data?.message?.content) ? r.obj.data.message.content : []
    const calls = blocks.filter(b => b && b.type === 'tool-call')
    if (calls.length) throw new Error('待删记录 seq=' + r.obj.seq + ' 带 ' + calls.length + ' 个 tool-call，拒绝删除')
  }
  // 断链门 2：任何保留的 tool/result 都不许引用待删 seq
  const straySeqs = new Set([...stray].map(r => r.obj.seq))
  for (const r of recs) {
    if (r.obj.type !== 'tool/result') continue
    const d = r.obj.data || {}
    const refSeqs = [d.seq, d.callSeq, d.startSeq].filter(v => typeof v === 'number')
    for (const s of refSeqs) if (straySeqs.has(s)) throw new Error('tool/result seq=' + r.obj.seq + ' 引用了待删 seq=' + s + '，拒绝删除')
  }

  // 删 + 重编 seq（未删记录只改 seq 数字，其余字节不动）
  const kept = recs.filter(r => !stray.has(r))
  const outLines = kept.map((r, i) => {
    const before = r.obj.seq
    if (before === i) return r.line
    r.obj.seq = i
    return JSON.stringify(r.obj)
  })
  // 自检 1：记录数 / seq 连续
  if (kept.length !== recs.length - stray.size) throw new Error('记录数对不上')
  const seqs = kept.map((r, i) => r.obj.seq)
  if (seqs.some((s, i) => s !== i)) throw new Error('seq 不连续')
  // 自检 2：残留判据
  const after = kept.map(r => r.obj)
  if (findStrays(kept).stray.size) throw new Error('还有步外助手消息未清干净')
  // 自检 3：tool_calls 配对（按宿主线格式重投影）
  const MSG = new Set(['user/message', 'system/message', 'assistant/message', 'tool/result'])
  const msgs = after.filter(o => MSG.has(o.type) && o.data && o.data.message).map(o => o.data.message)
  const idsOf = m => (Array.isArray(m && m.content) ? m.content : []).filter(b => b && b.type === 'tool-result' && b.toolCallId).map(b => b.toolCallId)
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (!m || m.role !== 'assistant') continue
    const calls = (m.content || []).filter(b => b && b.type === 'tool-call' && b.id).map(b => b.id)
    if (!calls.length) continue
    const need = new Set(calls)
    let j = i + 1
    while (j < msgs.length) { const ids = idsOf(msgs[j]); if (!ids.length) break; for (const id of ids) need.delete(id); j += 1 }
    if (need.size) throw new Error('重投影后仍缺 tool 结果：' + [...need].join(','))
  }
  // 自检 4：重打包（第 0 帧字节原样 + 正文按 ~1MB 分帧）
  const chunks = []
  let cur = [], size = 0
  for (const line of outLines) {
    cur.push(line); size += Buffer.byteLength(line, 'utf8') + 1
    if (size >= 1024 * 1024) { chunks.push(cur); cur = []; size = 0 }
  }
  if (cur.length) chunks.push(cur)
  const outBuf = Buffer.concat([
    buf.subarray(frames[0].off, frames[0].off + frames[0].len),
    ...chunks.map(c => zlib.zstdCompressSync(Buffer.from(c.join('\n') + '\n', 'utf8'))),
  ])
  // 自检 5：往返 + 头部字节等价
  const rt = scanFrames(outBuf)
  if (rt.torn !== null) throw new Error('重打包后有撕裂帧')
  const rtHeader = outBuf.subarray(frames[0].off, frames[0].off + frames[0].len).equals(buf.subarray(frames[0].off, frames[0].off + frames[0].len))
  if (!rtHeader) throw new Error('第 0 帧字节发生变化')
  const rtRecs = fixOne.__decode(rt, outBuf)
  if (rtRecs.length !== kept.length) throw new Error('往返后记录数不一致')
  if (rtRecs.map(o => o.seq).some((s, i) => s !== i)) throw new Error('往返后 seq 不连续')

  if (!quiet) {
    console.log('  第 0 帧：原样保留（' + frames[0].len + ' 字节）| 正文帧 ' + (frames.length - 1) + ' → ' + chunks.length)
    console.log('  字节：' + buf.length + ' → ' + outBuf.length)
    console.log('  记录：' + recs.length + ' → ' + kept.length + '（删 ' + stray.size + ' 条）')
    for (const r of [...stray].sort((a, b) => a.obj.seq - b.obj.seq)) {
      console.log('    - seq=' + r.obj.seq + '  ' + new Date((r.obj.time || 0) + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + '  ' + why.get(r))
    }
  }
  if (!apply) return { file, changed: stray.size, recs: recs.length, outBuf, dry: true }
  const tag = straySeqs.size ? [...straySeqs].sort((a, b) => a - b).slice(0, 3).join('_') : 'reseq'
  const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = file + '.bak-stray-' + stamp + '-seq' + tag
  fs.copyFileSync(file, backup)
  const tmp = file + '.tmp-repair2'
  fs.writeFileSync(tmp, outBuf)
  fs.renameSync(tmp, file)
  console.log('  ✅ 已修复 | 备份：' + path.basename(backup))
  return { file, changed: stray.size, recs: kept.length, backup }
}
fixOne.__decode = (frames, buf) => {
  const out = []
  for (let fi = 1; fi < frames.frames.length; fi++) {
    const t = dec(buf.subarray(frames.frames[fi].off, frames.frames[fi].off + frames.frames[fi].len))
    for (const l of t.split('\n')) if (l.trim()) out.push(JSON.parse(l))
  }
  return out
}

/* ── 扫描 / 执行 ─────────────────────────────────────────────────────────── */
const targets = []
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    if (frag && !s.includes(frag)) continue
    if (all && !frag && SELF && s === SELF) { console.log('跳过当前会话（本进程正在写它）：' + s); continue }
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) targets.push({ ws, sid: s, file: f }) // 只看 v3；旧 session.jsonl.zstd 目录自然落选
  }
}
if (!targets.length) { console.error('没有匹配的会话日志（frag=' + frag + '）'); process.exit(2) }

let touched = 0, skipped = 0, failed = 0, blocked = 0
for (const t of targets) {
  console.log('\n=== ' + t.sid + '  (' + t.ws + ')')
  try {
    const r = fixOne(t.file, { quiet: false })
    if (r.blocked) blocked += 1
    else if (r.changed > 0) touched += 1
    else skipped += 1
  } catch (e) {
    console.log('  ⛔ 拒绝/失败：' + e.message)
    failed += 1
  }
}
console.log('\n汇总：' + (apply ? '已修 ' : '待修 ') + touched + ' | 无需修 ' + skipped + ' | 被闸门拦下 ' + blocked + ' | 失败 ' + failed + (apply ? '' : '（演练模式，未写盘；加 --apply 落地）'))
