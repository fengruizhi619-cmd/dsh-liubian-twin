/**
 * meter_check.cjs — 用宿主自己的规则复核任一会话日志。
 * 规则原文照抄自 app.asar 内 node_modules/@deepseek-ai/dsh-token-meter/lib/index.js 的 _foldEvent()：
 *   step/start : 若已有 open step → "arrived before turn X/step Y ended"
 *   step/end   : 无 open step 或 turn/step 不匹配 → "has no matching step/start event"
 *   assistant/message : 无 open step 或 turn/step 不匹配 → "assistant/message at seq N has no matching step/start event"
 * 另加：seq 必须 0..N-1（冷读/续写都依赖它），并检查收尾时是否留下未闭合的 step。
 *
 *   node meter_check.cjs [frag]
 */
process.noAsar = true
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('node:zlib')
const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const frag = process.argv[2] || null

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
function events(file) {
  const buf = fs.readFileSync(file)
  const out = []
  let off = 0
  while (off < buf.length - 3) {
    const len = frameLength(buf, off)
    const text = zlib.zstdDecompressSync(buf.subarray(off, off + len)).toString('utf8')
    for (const l of text.split('\n')) {
      if (!l.trim()) continue
      const o = JSON.parse(l)
      if (o.type === 'session') continue // 会话头（第 0 帧首行），不是事件
      out.push(o)
    }
    off += len
  }
  return out
}
function foldMeter(evs) {
  let stepStart
  for (const event of evs) {
    switch (event.type) {
      case 'step/start':
        if (stepStart !== undefined) return { ok: false, why: `token meter: step/start at seq ${event.seq} arrived before turn ${stepStart.turn}/step ${stepStart.step} ended` }
        stepStart = { ...event.data }
        break
      case 'step/end':
        if (stepStart === undefined || stepStart.turn !== event.data.turn || stepStart.step !== event.data.step) return { ok: false, why: `token meter: step/end at seq ${event.seq} has no matching step/start event` }
        stepStart = undefined
        break
      case 'assistant/message':
        if (stepStart === undefined || stepStart.turn !== event.data.turn || stepStart.step !== event.data.step) return { ok: false, why: `token meter: assistant/message at seq ${event.seq} has no matching step/start event` }
        break
      default: break
    }
  }
  return { ok: true, danglingStep: stepStart ? `turn ${stepStart.turn}/step ${stepStart.step}` : null }
}
const files = []
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    if (frag && !s.includes(frag)) continue
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) files.push({ sid: s, file: f })
  }
}
let ok = 0, bad = 0, dang = 0
for (const f of files) {
  let evs
  try { evs = events(f.file) } catch (e) { console.log('READ-FAIL ' + f.sid + ': ' + e.message); bad += 1; continue }
  const seqBad = evs.findIndex((e, i) => e.seq !== i)
  const r = foldMeter(evs)
  if (r.ok && seqBad < 0) {
    ok += 1
    if (r.danglingStep) { dang += 1; console.log('METER-OK  ' + f.sid + '（收尾留有未闭合 step：' + r.danglingStep + '——正常，表示该轮还没结束）') }
    else if (frag) console.log('METER-OK  ' + f.sid + ' 记录 ' + evs.length)
  } else {
    bad += 1
    console.log('METER-FAIL ' + f.sid + ': ' + (seqBad >= 0 ? `seq 断档 @记录#${seqBad}（seq=${evs[seqBad].seq}，共 ${evs.length} 条）` : r.why))
  }
}
console.log('\n宿主 token-meter 规则重放：通过 ' + ok + ' | 不通过 ' + bad + '（未闭合 step 属正常：' + dang + '）')
process.exit(bad === 0 ? 0 : 1)
