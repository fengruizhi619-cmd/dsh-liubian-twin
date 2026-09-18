/**
 * 扫全库会话，找两类问题（同一套解码/遍历，不再另建脚本）：
 *   默认      —— "监察记录缺 reasoning 块"（思考模式下会让该会话之后每轮请求被上游拒收）
 *   --dup     —— "监察注入重复打印"：注入的纠正、监察记录、notice 三类计数 + 同文比对
 *
 *   node _dev/find_bad_records.cjs
 *   node _dev/find_bad_records.cjs --dup
 */
process.noAsar = true
const fs = require('fs')
const os = require('os')
const path = require('path')
const dec = require('C:/Users/Feng/.dsh/skills/dsh-plugin-checklist/scripts/decode-session.cjs')

const SESSIONS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const DUP = process.argv.includes('--dup')
// 显式常量：比对取多长、注入消息的前缀长什么样（改口径只改这两行）
const SNIPPET = 60
const INJ_PREFIX = '＜孪生监察·纠正＞'
const TWIN_TEXT_RE = /〔监察〕/
const RECORD_PREFIX_RE = /^〔监察〕(通过|纠正)：/

if (!fs.existsSync(SESSIONS)) throw new Error('会话目录不存在：' + SESSIONS)

const local = ms => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
const textOf = m => (Array.isArray(m?.content) ? m.content.filter(b => b?.type === 'text').map(b => b.text).join('') : String(m?.content || ''))

/** 纯判定：给一组记录，返回三类清单（不碰文件系统，便于自检） */
function classify(recs) {
  const inj = [], rec = [], notice = []
  recs.forEach((r, i) => {
    const m = r.data?.message
    if (!m) return
    const t = textOf(m)
    if (m.role === 'user' && m.source?.kind === 'plugin' && t.includes(INJ_PREFIX)) inj.push({ i, t: r.time, body: t.split(INJ_PREFIX).join('').trim() })
    else if (m.role === 'user' && m.source?.form === 'notice') notice.push({ i, t: r.time, body: t })
    else if (m.role === 'assistant' && TWIN_TEXT_RE.test(t)) rec.push({ i, t: r.time, body: t, hasReasoning: (m.content || []).some(b => b?.type === 'reasoning') })
  })
  return { inj, rec, notice }
}
/** 同文判定：注入纠正正文与监察记录正文（去掉结论词前缀）前 SNIPPET 字重合 */
function isDuplicate(injBody, recBody) {
  const a = String(injBody).slice(0, SNIPPET)
  const b = String(recBody).replace(RECORD_PREFIX_RE, '').slice(0, SNIPPET)
  return a.length > 10 && b.length > 10 && (a === b || a.startsWith(b) || b.startsWith(a))
}

/* ── 自检：一例预期命中、一例预期不命中 ── */
{
  const body = '只改 A，把 B 撤回，其余别动，这是一段足够长的纠正正文'
  const hit = classify([
    { data: { message: { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: INJ_PREFIX + '\n' + body }] } } },
    { data: { message: { role: 'assistant', content: [{ type: 'text', text: '〔监察〕纠正：' + body }] } } },
  ])
  if (hit.inj.length !== 1 || hit.rec.length !== 1) throw new Error('自检失败：三类归类不对')
  if (!isDuplicate(hit.inj[0].body, hit.rec[0].body)) throw new Error('自检失败：预期命中的同文没判出来')
  const miss = classify([{ data: { message: { role: 'assistant', content: [{ type: 'text', text: '〔监察〕通过：这一步与用户指令一致' }] } } }])
  if (isDuplicate('完全不相干的一段纠正正文，用来验证不命中', miss.rec[0].body)) throw new Error('自检失败：不该命中的判成了重复')
  console.log('自检通过（一例命中、一例不命中）')
}

let files = 0
let decodeFail = 0
let hits = 0
let scanned = 0
const dupBySession = []
for (const ws of fs.readdirSync(SESSIONS)) {
  const wsDir = path.join(SESSIONS, ws)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const s of fs.readdirSync(wsDir)) {
    const f = path.join(wsDir, s, 'session.v3.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    files += 1
    let text = ''
    try { text = dec.decodeSessionFile(f).text } catch { decodeFail += 1; continue } // 失败单独计数，不静默吞
    if (!text.includes('〔监察〕')) continue
    scanned += 1
    const recs = text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    if (!DUP) {
      for (let i = 0; i < recs.length; i++) {
        if (recs[i].type !== 'assistant/message') continue
        const m = recs[i].data?.message
        const blocks = Array.isArray(m?.content) ? m.content : []
        if (blocks.some(b => b?.type === 'text' && String(b.text || '').startsWith('〔监察〕')) && !blocks.some(b => b?.type === 'reasoning')) {
          hits += 1
          if (hits <= 12) console.log(`  ${s}  #${i}  ${local(recs[i].time)}  turn=${recs[i].data?.turn} step=${recs[i].data?.step}  块=[${blocks.map(b => b.type).join(',')}]`)
        }
      }
      continue
    }
    const { inj, rec, notice } = classify(recs)
    if (!inj.length && !rec.length && !notice.length) continue
    const dups = []
    for (const a of inj) for (const r of rec) if (isDuplicate(a.body, r.body)) dups.push({ at: a.t, recAt: r.t })
    dupBySession.push({ s, inj: inj.length, rec: rec.length, notice: notice.length, dups })
  }
}

if (files === 0) throw new Error('一个会话文件都没扫到：' + SESSIONS)
if (scanned === 0) throw new Error('扫到 0 个含监察痕迹的会话，结论不可信：' + SESSIONS)
if (DUP) {
  console.log(`扫描 ${files} 个会话文件（解码失败 ${decodeFail}），其中含监察痕迹 ${scanned} 个`)
  let printed = 0
  for (const d of dupBySession) {
    console.log(`\n=== ${d.s}｜注入纠正 ${d.inj} / 监察记录 ${d.rec} / notice ${d.notice}｜同文重复 ${d.dups.length}`)
    for (const x of d.dups) { console.log(`    ⚠ ${local(x.recAt)} 的记录与 ${local(x.at)} 的注入纠正同文`); printed += 1 }
  }
  const total = dupBySession.reduce((n, d) => n + d.dups.length, 0)
  if (printed !== total) throw new Error(`打印条数(${printed})与统计(${total})不一致`)
  console.log(`\n结论：${dupBySession.length} 个会话有监察痕迹，"注入纠正与监察记录同文"共 ${total} 处`)
} else {
  console.log(`扫描 ${files} 个会话（解码失败 ${decodeFail}）：含监察记录 ${scanned} 个，缺 reasoning 的监察记录 ${hits} 条`)
}
