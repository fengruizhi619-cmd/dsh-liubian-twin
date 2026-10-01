#!/usr/bin/env node
/**
 * mount_health.mjs 的自测（夹具制，四态）。**探针本身必须先被验**。
 *
 *   node _dev/mount_health_test.mjs
 *
 * 为什么要它：2026-10-01 那次「孪生不见了」的排查里，旧版 mount_health 把
 * 「不在 bundles」一律报 ❌ 并建议「把名字加回 bundles」——而孪生当时是**有意停用**，
 * 照它改就是一次无人批准的全局启用。工具给的错误建议比没有工具更危险，
 * 所以它的判据必须自己先被验。
 *
 * 四个夹具只改必要变量，其中 **A 与 C 只差一个「市场停用账本」**——
 * 这是本自测的判别对：同一个「不在 bundles」现场，账本在则信息项（exit 0），
 * 账本不在则故障（exit 1）。判据要是退化了，这两条必有一条红。
 *
 * 隔离：每个夹具自建临时 DSH_HOME / APPDATA，**不碰真实 profile**。
 *
 * ⚠️ 2026-10-01 事故（本文件第一版留下的，已修）：夹具曾用 `symlinkSync(..., 'junction')`
 * 把 node_modules 链到**真实插件目录**，而清理时的 `rmSync(fixtureRoot, {recursive:true})`
 * **沿链接删进了真仓库** —— 孪生仓库的 `.git` 元数据被删掉一半（HEAD/config/index 全没，
 * 只剩 objects/refs；工作树侥幸无损，最终靠 origin 克隆恢复）。
 * 现在夹具只用**普通空目录**（mount_health 的 linkHealthy() 对两者判据一致），
 * 并且**禁止**再往夹具里放任何指向真实路径的链接。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, readFileSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'mount_health.mjs')
const PLUGIN_DIR = resolve(HERE, '..')
const PKG = 'dsh-liubian-twin'

const results = []
const cleanupWarnings = []
function check(name, fn) {
  try { fn(); results.push(`PASS  ${name}`) } catch (err) {
    results.push(`FAIL  ${name}\n      ${(err && err.message) || err}`)
    process.exitCode = 1
  }
}

/** 跑一次体检：用临时 DSH_HOME/APPDATA，输出走**文件**而不是管道（避免受限模式下的命名管道问题）。 */
function runFixture({ bundles, patchRows, market, desktop, link }) {
  const root = mkdtempSync(join(tmpdir(), 'twin-health-'))
  const dsh = join(root, 'dsh')
  const appdata = join(root, 'appdata')
  const prof = join(dsh, 'profiles', 'desktop')
  mkdirSync(join(prof, '.dsh-market'), { recursive: true })
  mkdirSync(join(appdata, 'DSH Desktop', 'plugin-management'), { recursive: true })

  writeFileSync(join(prof, 'package.json'), JSON.stringify({
    name: 'desktop',
    private: true,
    dependencies: { [PKG]: 'link:' + PLUGIN_DIR },
    dsh: { profile: { bundles: bundles ? [PKG] : ['@deepseek-ai/dsh-base'] } },
  }, null, 2))

  writeFileSync(join(prof, 'cordis.patch.yml'),
    patchRows ? `# 夹具：指向孪生的 patch 行\n- id: ${PKG}\n  disabled: true\n`
      : `# 夹具：无孪生条目\n- id: other-plugin\n  disabled: false\n`)

  writeFileSync(join(prof, '.dsh-market', 'state.json'), JSON.stringify({ disabled: market }))
  writeFileSync(join(appdata, 'DSH Desktop', 'plugin-management', 'state.json'),
    JSON.stringify({ version: 1, profiles: [{ profileName: 'desktop', disabledBundles: desktop }] }))

  if (link) {
    // ⚠ 故意**不建 junction**。夹具里的 node_modules 若是指向真实插件目录的 junction，
    //   那么 `rmSync(fixtureRoot, {recursive:true})` 会**沿链接删进真仓库**——
    //   2026-10-01 就这么把孪生仓库的 `.git` 元数据删掉了一半（HEAD/config/index 全没，
    //   只剩 objects/refs；工作树侥幸无损，靠 origin 克隆才救回来）。
    //   mount_health 的 linkHealthy() 对「真目录」与「junction」判据一致（能读目录即健康），
    //   所以用普通空目录做夹具既等价、又零风险。**不要把 junction 加回来。**
    mkdirSync(join(prof, 'node_modules', PKG), { recursive: true })
  }
  const logPath = join(root, 'out.txt')
  const fd = openSync(logPath, 'w')
  const r = spawnSync(process.execPath, [SCRIPT, '--profile=desktop'], {
    // ⚠ 必须显式带上 ELECTRON_RUN_AS_NODE：本机 `node` 是 DSH 的包装脚本
    // （node.cmd → "DSH Desktop.exe" --import clear-env.mjs），而 clear-env
    // **会把 ELECTRON_RUN_AS_NODE 清掉**。少了这一个变量，子进程会用
    // process.execPath 启动 **Electron GUI**：脚本一行都不跑、输出为空、
    // exit 0 —— 一次彻头彻尾的假绿（本自测第一版就这么红过一遍）。
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dsh, APPDATA: appdata },
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  const text = readFileSync(logPath, 'utf8')
  // 夹具清理：**尽力而为，绝不阻断断言**。残留不影响判据，只在末尾提示路径。
  // 夹具环境问题不许把测试本身炸掉（今天已踩过一次「夹具副作用造成假红」）。
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  catch {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    catch { cleanupWarnings.push(root) }
  }
  return { text, code: r.status }
}

// ── A｜有意停用（与 C 只差市场停用账本）：不在 bundles + patch disabled 行 + 市场记了停用
{
  const a = runFixture({ bundles: false, patchRows: true, market: [PKG], desktop: [], link: false })
  check('A 有意停用 → exit 0（不是故障）+ 点明「停用记录」', () => {
    if (a.code !== 0) throw new Error(`exit=${a.code}（期望 0）\n${a.text}`)
    if (!a.text.includes('有意停用')) throw new Error('结论里没有「有意停用」')
    if (!a.text.includes('市场 OFF 的停用记录')) throw new Error('⑤ 没有把它认成停用记录（会误导人删掉它）')
    if (!a.text.includes('只把名字加回 bundles')) throw new Error('① 没有给出「别擅自启用」的警告')
  })
}

// ── C｜静默消失（判别对的另一半）：不在 bundles + patch 行在 + **两个账本都没记**
{
  const c = runFixture({ bundles: false, patchRows: true, market: [], desktop: [], link: false })
  check('C 无停用账本 → exit 1 + 判为「静默消失」', () => {
    if (c.code !== 1) throw new Error(`exit=${c.code}（期望 1）\n${c.text}`)
    if (!c.text.includes('静默消失')) throw new Error('没有判为静默消失')
  })
}

// ── B｜真阻断：bundles 里有它、patch 又写 disabled → 必须报「阻断自装配」
{
  const b = runFixture({ bundles: true, patchRows: true, market: [], desktop: [], link: true })
  check('B bundles 含 + patch disabled → exit 1 + 「阻断自装配」', () => {
    if (b.code !== 1) throw new Error(`exit=${b.code}（期望 1）\n${b.text}`)
    if (!b.text.includes('阻断自装配')) throw new Error('没有报出阻断自装配')
  })
}

// ── D｜一致（启用态）：bundles 含 + 无 patch 行 + 两账本都不含 + junction 健康
{
  const d = runFixture({ bundles: true, patchRows: false, market: [], desktop: [], link: true })
  check('D 启用态一致 → exit 0 + 「四个面一致」', () => {
    if (d.code !== 0) throw new Error(`exit=${d.code}（期望 0）\n${d.text}`)
    if (!d.text.includes('四个面一致')) throw new Error('结论不是「四个面一致」')
  })
}

// ── ⑧ 账本不一致要被报出来（今天实测：市场 4 项 vs Desktop 1 项）
{
  const e = runFixture({ bundles: true, patchRows: false, market: ['dsh-synapse', 'dsh-deepseek-eye'], desktop: ['dsh-synapse'], link: true })
  check('⑧ 两账本不一致 → 报出「只有市场记了」的那批', () => {
    if (!e.text.includes('互不一致')) throw new Error('没有报出账本不一致')
    if (!e.text.includes('dsh-deepseek-eye')) throw new Error('没有点名差异项')
  })
}

console.log(results.join('\n'))
if (cleanupWarnings.length) console.log(`\n（提示：${cleanupWarnings.length} 个夹具临时目录未能删除，可手工清理——不影响以上判据）\n${cleanupWarnings.join('\n')}`)
console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} 通过`)
