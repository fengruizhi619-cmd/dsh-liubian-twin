#!/usr/bin/env node
/**
 * 孪生的「挂载面」体检（**只读，绝不写任何文件**）。
 *
 * 为什么需要它：孪生的启停状态被**四个互不知情的写者**同时改，键形还不一样
 * （包名 `dsh-liubian-twin` vs 市场行哈希 id），任何一个写歪都能让孪生
 * 「静默消失」而日志里一条错都没有。这个脚本把四个面一次性摊开核对：
 *
 *   ① profile 清单 dsh.profile.bundles    ← 唯一权威的挂载来源（bundle 自装配）
 *   ② profile node_modules 的 junction     ← 解析面；断了则整个 profile 的
 *                                            HMR 重载都会 PackageOverlayNotFound
 *   ③ 注入器 registry.json 的孪生条目      ← 遗留的双挂载源（与 ① 抢挂载权）
 *   ④ profile patch 里指向孪生的行         ← 注入器 uninject / 市场开关的残渣通道
 *   ⑤ 市场账本 desktopDeselectedBundles    ← 「Desktop 从 bundles 移除过它」的记录
 *   ⑥ Desktop 私有停用表 disabledBundles   ← **唯一真正会静默屏蔽 bundle 的策略**
 *
 * 用法：
 *   node _dev/mount_health.mjs                 # 默认 profile=desktop
 *   node _dev/mount_health.mjs --profile=web
 * 退出码：0 = 四个面一致；1 = 存在需要处理的不一致（逐条给修法）。
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = 'dsh-liubian-twin'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

const argProfile = process.argv.find(a => a.startsWith('--profile='))
const PROFILE = argProfile ? argProfile.slice('--profile='.length) : (process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'desktop')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)

const lines = []
let bad = 0
let warn = 0
function out(mark, title, detail, fix) {
  lines.push(`${mark} ${title}`)
  if (detail) for (const d of [].concat(detail)) lines.push(`    ${d}`)
  if (fix) lines.push(`    ↳ ${fix}`)
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return undefined }
}
function readText(p) {
  try { return readFileSync(p, 'utf8').replace(/^\uFEFF/, '') } catch { return undefined }
}
/** junction 健康：能读目录才算活（Windows 断电后的悬空 junction lstat 仍是链接但读目录抛错）。 */
function linkHealthy(p) {
  try { if (!lstatSync(p).isSymbolicLink() && !lstatSync(p).isDirectory()) return false; readdirSync(p); return true } catch { return false }
}

// ── ① profile 清单：bundles（唯一权威来源）+ 依赖声明 ──────────────────────────
const manifestPath = join(PROFILE_DIR, 'package.json')
const manifest = readJson(manifestPath)
if (manifest === undefined) {
  out('❌', `读不到 profile 清单 ${manifestPath}`, null, '确认 profile 名（--profile=）与 DSH_HOME')
  bad++
} else {
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  const dep = manifest?.dependencies?.[PKG]
  if (bundles.includes(PKG)) out('✅', '① profile bundles 含孪生（bundle 自装配在位）')
  else { out('❌', '① profile bundles 不含孪生 → 孪生不会挂载', `bundles = ${JSON.stringify(bundles)}`, `把 "${PKG}" 加回 dsh.profile.bundles（或走 Desktop 插件页启用）`); bad++ }
  if (typeof dep === 'string' && dep.startsWith('link:')) {
    const target = dep.slice(5)
    if (resolve(target) === PLUGIN_DIR) out('✅', `② dependencies 声明 link: → 本仓库（${target}）`)
    else out('⚠️', '② dependencies 的 link: 指向别处', `声明 ${target}｜本仓库 ${PLUGIN_DIR}`, '确认是否有多份孪生副本')
  } else if (dep === undefined) { out('❌', '② dependencies 缺孪生 → junction 不会被重建', null, `加 "${PKG}": "link:${PLUGIN_DIR}"`); bad++ }
  else out('⚠️', '② dependencies 的孪生不是 link: 形式', String(dep))

  const own = readJson(join(PLUGIN_DIR, 'package.json'))
  if (own?.dsh?.bundle?.patch) out('✅', `插件自带 bundle 元数据（dsh.bundle.patch = ${own.dsh.bundle.patch}）`)
  else { out('❌', '插件 package.json 缺 dsh.bundle.patch → 装配无 patch 层', null, '补 dsh.bundle.patch'); bad++ }
}

// ── ③ profile node_modules junction（解析面）──────────────────────────────────
const linkPath = join(PROFILE_DIR, 'node_modules', PKG)
if (!existsSync(linkPath)) {
  out('❌', `③ junction 不存在：${linkPath}`, null, '整个 profile 的 patch/package.json 重载都会 PackageOverlayNotFound；**手工重建该 junction**（或在 profile 目录跑一次 `pnpm install`）——注入器的启动自愈已随其退役消失（2026-10-01 管理员指令）')
  bad++
} else if (!linkHealthy(linkPath)) {
  out('❌', `③ junction 存在但目标不可读（悬空）：${linkPath}`, null, '删掉后重建 junction 指向 ' + PLUGIN_DIR)
  bad++
} else out('✅', `③ junction 健康：${linkPath} → ${PLUGIN_DIR}`)

// ── ④ 注入器 registry（**历史面**：2026-10-01 管理员指令全家解耦、该插件将删除；本项只用于查残渣）──
const registryPath = join(DSH_HOME, 'super-injector', 'registry.json')
const registry = readJson(registryPath) ?? []
const regHit = Array.isArray(registry) ? registry.filter(e => String(e?.name ?? '') === PKG || String(e?.dir ?? '').includes(PKG)) : []
if (regHit.length === 0) out('✅', '④ 注入器 registry 无孪生条目（单挂载源）')
else {
  out('⚠️', '④ 注入器 registry 仍有孪生条目 → 双挂载源（registry 与 profile bundles 指同一包名）',
    regHit.map(e => `at=${e.at} dir=${e.dir}`),
    '孪生已是纯 bundle 插件，此条目是历史遗留：删掉该条目即可（`dev_uninject_plugin` 不要用——它删 junction 并往共享 patch 写 disabled:true；而 inject() 对「已在运行」的包会早退，早退发生在 junction 修复之前）')
  warn++
}

// ── ⑤ profile patch 里指向孪生的行 ──────────────────────────────────────────
const patchPath = join(PROFILE_DIR, 'cordis.patch.yml')
const patchText = readText(patchPath)
if (patchText === undefined) out('⚠️', `⑤ 读不到 profile patch ${patchPath}`)
else {
  const rows = []
  const raw = patchText.split(/\r?\n/)
  for (let i = 0; i < raw.length; i++) {
    if (!/^-\s+id:/.test(raw[i])) continue
    const body = [raw[i]]
    for (let j = i + 1; j < raw.length && !/^-\s+/.test(raw[j]) && !/^#/.test(raw[j]); j++) { if (raw[j].trim() === '') break; body.push(raw[j]) }
    const block = body.join('\n')
    if (block.includes(PKG)) rows.push({ line: i + 1, block })
  }
  if (rows.length === 0) out('✅', '⑤ profile patch 无孪生条目')
  else {
    const disabledRows = rows.filter(r => /\n\s+disabled:\s*true/.test('\n' + r.block))
    out(disabledRows.length ? '❌' : '⚠️', `⑤ profile patch 有 ${rows.length} 条孪生条目（其中 disabled:true ${disabledRows.length} 条）`,
      rows.map(r => `L${r.line}: ${r.block.split('\n')[0].trim()}`),
      disabledRows.length
        ? '本 profile patch 自己的注释即写明「disabled 阻断其 bundle patch 自装配」；这类行在，孪生就会不见且日志无错——删掉这些行'
        : '这类行只是按 id 的配置覆盖（与插件内 bundle patch 的 id 同名），未能证明有功能影响；要干净可删（共享文件，改前先备份+征得同意）')
    if (disabledRows.length) bad++
  }
  const orphans = (patchText.match(/^-\s+id:\s*[0-9a-f]{8}\s*$/gm) ?? []).length
  if (orphans > 0) lines.push(`    （附注：patch 里还有 ${orphans} 条 8 位哈希 id 行——市场开关写的历史残渣，每次重载都会 'patch: entry ... not found' 噪声）`)
}

// ── ⑥ 市场账本（advisory）与 Desktop 私有停用表（policy）────────────────────
if (manifest !== undefined) {
  const ledger = manifest?.dsh?.desktopDeselectedBundles ?? []
  if (ledger.includes(PKG)) {
    out('⚠️', '⑥ 市场账本 desktopDeselectedBundles 列了孪生，但 bundles 里也有它（自相矛盾）',
      'DSH 的 reconcileDeselectedBundles 会把「已在 bundles」的名字过滤掉，所以当前无害；但账本语义是「Desktop 把它从 bundles 移除过」',
      '可删掉该名字（共享文件，改前备份）；只要 bundles 一直含孪生就不会生效')
    warn++
  } else out('✅', '⑥ 市场账本未列孪生')
}
const statePath = process.env.APPDATA ? join(process.env.APPDATA, 'DSH Desktop', 'plugin-management', 'state.json') : undefined
if (statePath && existsSync(statePath)) {
  const st = readJson(statePath)
  const mine = (st?.profiles ?? []).find(p => p?.profileName === PROFILE)
  const disabled = mine?.disabledBundles ?? []
  if (disabled.includes(PKG)) {
    out('❌', '⑦ Desktop 私有停用表把孪生标停用 → 这是**真正会静默屏蔽**的策略',
      `${statePath} → profiles[${PROFILE}].disabledBundles`,
      'Desktop 插件页启用，或从该数组删掉（activeDesktopProfileLayers 会直接过滤掉该 bundle 层，日志无错）')
    bad++
  } else out('✅', `⑦ Desktop 私有停用表未屏蔽孪生（本 profile 停用项：${JSON.stringify(disabled)}）`)
} else if (statePath) out('✅', '⑦ Desktop 私有停用表不存在（无停用项）')

// ── 摘要 ───────────────────────────────────────────────────────────────────
console.log(`孪生挂载面体检｜profile=${PROFILE}｜DSH_HOME=${DSH_HOME}`)
console.log(`插件目录 ${PLUGIN_DIR}`)
console.log('')
console.log(lines.join('\n'))
console.log('')
console.log(bad > 0 ? `结论：❌ ${bad} 处需要处理，${warn} 处提醒` : `结论：✅ 四个面一致（${warn} 处提醒）`)
process.exit(bad > 0 ? 1 : 0)
