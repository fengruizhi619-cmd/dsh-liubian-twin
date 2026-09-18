/**
 * 打开孪生：把 profile patch 里 `- id: dsh-liubian-twin / disabled: true` 两行摘掉（先备份）。
 *   node _dev/enable_twin.cjs            # 打开
 *   node _dev/enable_twin.cjs --close    # 再关回去（写回 disabled 块）
 */
process.noAsar = true
const fs = require('fs')
const p = 'C:/Users/Feng/.dsh/profiles/desktop/cordis.patch.yml'
const src = fs.readFileSync(p, 'utf8')
const block = '- id: dsh-liubian-twin\n  disabled: true\n'
const close = process.argv.includes('--close')

const bak = p + '.bak-twin-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

if (close) {
  if (src.includes(block)) { console.log('已经是关闭状态'); process.exit(0) }
  fs.writeFileSync(bak, src, 'utf8')
  const out = src.replace(/- id: dsh-liubian-embed\n  disabled: true\n/, m => m + block)
  if (!out.includes(block)) throw new Error('没找到插入点（dsh-liubian-embed 那一段）')
  fs.writeFileSync(p, out, 'utf8')
  console.log('已写回 disabled（关闭孪生）。备份:', bak)
} else {
  if (!src.includes(block)) { console.log('没找到 disabled 块——可能已经打开'); process.exit(0) }
  fs.writeFileSync(bak, src, 'utf8')
  fs.writeFileSync(p, src.replace(block, ''), 'utf8')
  console.log('已移除 disabled 两行（下次启动 DSH 生效）。备份:', bak)
}
const back = fs.readFileSync(p, 'utf8')
console.log('现在还有 disabled 块:', back.includes(block))
console.log('--- patch 尾部 6 行 ---')
console.log(back.split('\n').slice(-7).join('\n'))
