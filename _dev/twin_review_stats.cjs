/**
 * 统计孪生自己的审查记录（README「它实际抓到了什么」一节的复算脚本）。
 *
 *   node _dev/twin_review_stats.cjs
 *
 * 口径（避免把不同性质的东西混成同一个数字）：
 *   - 只统计真实会话（session-*.jsonl）；桩测产物（S-*.jsonl）单列，不计入。
 *   - 解析失败、缺 verdict 的记录**单独计数**，不并入"判偏离"；任一不为 0 时退出码 2，
 *     提示上面的通过/偏离数字不可直接引用。
 *   - "判偏离" = verdict.conform 明确为 false。它只代表**监察判为偏离**，不等于客观真错；
 *     理由原文一并列出，供人工核对。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const dir = path.join(DSH_HOME, 'liubian-twin', 'sessions')
const local = ms => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)

if (!fs.existsSync(dir)) {
  console.error('没有审查记录目录：' + dir)
  process.exit(3)
}
const files = fs.readdirSync(dir).filter(x => x.endsWith('.jsonl'))
const real = files.filter(f => f.startsWith('session-'))
const stub = files.filter(f => !f.startsWith('session-'))

let tot = 0, conf = 0, deny = 0, parseFail = 0, noVerdict = 0, emptyFiles = 0
const denies = []
let shapeShown = false

for (const f of real) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(l => l.trim())
  if (!raw.length) { emptyFiles += 1; continue }
  let c = 0, d = 0, pf = 0, nv = 0
  for (const l of raw) {
    let o
    try { o = JSON.parse(l) } catch { pf += 1; continue }
    tot += 1
    if (!shapeShown) { console.log('首条记录字段: ' + Object.keys(o).join(', ')); shapeShown = true }
    if (!o.verdict || typeof o.verdict.conform !== 'boolean') { nv += 1; continue }
    if (o.verdict.conform) { conf += 1; c += 1 } else {
      deny += 1; d += 1
      denies.push({
        t: o.time, kind: o.kind, file: f.slice(8, 16),
        why: String(o.verdict.correction || o.verdict.reason || '').replace(/\s+/g, ' ').slice(0, 120),
      })
    }
  }
  parseFail += pf; noVerdict += nv
  console.log(`${f.slice(0, 46).padEnd(48)} 行 ${String(raw.length).padStart(3)}  解析失败 ${pf}  缺 verdict ${nv}  通过 ${String(c).padStart(3)}  判偏离 ${String(d).padStart(3)}`)
}

console.log(`\n真实会话：文件 ${real.length} 个（空文件 ${emptyFiles}）| 可判记录 ${tot} 条 → 通过 ${conf}，判偏离 ${deny}`)
console.log(`数据可信度：解析失败 ${parseFail} 条 | 缺 verdict ${noVerdict} 条 | 桩测文件 ${stub.length} 个（未计入）`)
if (parseFail || noVerdict || emptyFiles) {
  console.log('⚠ 存在无法判读的记录或空文件，上面的通过/偏离数字不可直接引用')
  process.exitCode = 2
}
console.log('\n判偏离明细（时间 | 被审类型 | 会话 | 理由开头）：')
for (const x of denies.sort((a, b) => a.t - b.t)) {
  console.log(`  ${local(x.t)}  ${String(x.kind).padEnd(4)}  ${x.file}  ${x.why}`)
}
