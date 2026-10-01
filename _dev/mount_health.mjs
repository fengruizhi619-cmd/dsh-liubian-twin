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
 * 2026-10-01 增补（青芷｜背景：15:18:28 管理员在插件市场把孪生 toggle off）：
 *
 *   ⑨ **区分「有意停用」与「静默消失」**。市场 OFF 一次动三处（移出 bundles +
 *      写 patch disabled 行 + 市场 state.json 标停用）。旧版把「不在 bundles」
 *      一律报 ❌ 并建议「把名字加回 dsh.profile.bundles」——那是一次**危险的误判**：
 *      孪生当前是**有意停用**，照它改等于发动一次无人批准的全局启用（孪生是
 *      全会话级闸门，一开所有会话的每个动作都可能停等一次模型往返）。
 *      现在先读两个停用账本（市场 state.json / Desktop plugin-management），
 *      命中即降级为**信息项**，exit code 不受影响。
 *
 *   ⑧ **两个"官方开关"账本自身的一致性**。实测它们互不一致：市场停用 4 项
 *      （dsh-synapse / bridge-browser / deepseek-eye / dsh-liubian-twin），
 *      Desktop 只有 1 项（dsh-synapse）。按错的那个 reconcile 会打架（市场把它
 *      当停用、官方页当启用，而 patch 里的 disabled 行又摁着它）。
 *
 * 用法：
 *   node _dev/mount_health.mjs                 # 默认 profile=desktop
 *   node _dev/mount_health.mjs --profile=web
 * 退出码：0 = 与账本一致（含「有意停用」）；1 = 存在需要处理的不一致（逐条给修法）。
 *
 * 自测：`node _dev/mount_health_test.mjs`（临时 DSH_HOME/APPDATA 夹具，四态）。
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

// ── ⓪ 先读两个「停用账本」：它们决定「不在 bundles」到底是故障还是设定 ──────────
const marketPath = join(PROFILE_DIR, '.dsh-market', 'state.json')
const marketState = readJson(marketPath)
const marketDisabled = Array.isArray(marketState?.disabled) ? marketState.disabled : []
const marketOff = marketDisabled.includes(PKG)

const desktopStatePath = process.env.APPDATA
  ? join(process.env.APPDATA, 'DSH Desktop', 'plugin-management', 'state.json')
  : undefined
const desktopState = desktopStatePath && existsSync(desktopStatePath) ? readJson(desktopStatePath) : undefined
const desktopDisabled = (desktopState?.profiles ?? []).find(p => p?.profileName === PROFILE)?.disabledBundles ?? []
const desktopOff = desktopDisabled.includes(PKG)

const offLedgers = []
if (marketOff) offLedgers.push(`市场 state.json disabled（${marketPath}）`)
if (desktopOff) offLedgers.push(`Desktop plugin-management disabledBundles（${desktopStatePath}）`)
const intentionallyOff = offLedgers.length > 0

// ── ① profile 清单：bundles（唯一权威来源）+ 依赖声明 ──────────────────────────
const manifestPath = join(PROFILE_DIR, 'package.json')
const manifest = readJson(manifestPath)
let bundles = []
if (manifest === undefined) {
  out('❌', `读不到 profile 清单 ${manifestPath}`, null, '确认 profile 名（--profile=）与 DSH_HOME')
  bad++
} else {
  bundles = manifest?.dsh?.profile?.bundles ?? []
  const dep = manifest?.dependencies?.[PKG]
  if (bundles.includes(PKG)) out('✅', '① profile bundles 含孪生（bundle 自装配在位）')
  else if (intentionallyOff) {
    out('ℹ️', '① 孪生不在 bundles —— 账本显示它被**有意停用**（这是设定，不是故障）',
      offLedgers.map(l => `停用记录：${l}`),
      '要启用请照 `_dev/启用核对清单_20261001.md` §2 走（四处账本一起改）。**别**只把名字加回 bundles：孪生是全会话级闸门，一开所有会话的每个动作都可能停等一次模型往返，启用必须是有意动作')
  } else {
    out('❌', '① profile bundles 不含孪生 → 孪生不会挂载，且没有任何停用账本记录它（= 静默消失）',
      `bundles = ${JSON.stringify(bundles)}`,
      `把 "${PKG}" 加回 dsh.profile.bundles（或走 Desktop 插件页启用）；若这是有意停用，先把停用记录补进账本再谈`)
    bad++
  }
  if (typeof dep === 'string' && dep.startsWith('link:')) {
    const target = dep.slice(5)
    if (resolve(target).toUpperCase() === PLUGIN_DIR.toUpperCase()) out('✅', `② dependencies 声明 link: → 本仓库（${target}）`)
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
  if (intentionallyOff) out('ℹ️', `③ junction 不存在：${linkPath}`, '有意停用态下这不影响现状；启用前需重建', '照启用核对清单 §2 走（或在 profile 目录跑一次 `pnpm install`）')
  else {
    out('❌', `③ junction 不存在：${linkPath}`, null, '整个 profile 的 patch/package.json 重载都会 PackageOverlayNotFound；**手工重建该 junction**（或在 profile 目录跑一次 `pnpm install`）——注入器的启动自愈已随其退役消失（2026-10-01 管理员指令）')
    bad++
  }
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
    for (let j = i + 1; j < raw.length && !/^-\s/.test(raw[j]) && !/^#/.test(raw[j]); j++) { if (raw[j].trim() === '') break; body.push(raw[j]) }
    const block = body.join('\n')
    if (block.includes(PKG)) rows.push({ line: i + 1, block })
  }
  const disabledRows = rows.filter(r => /\n\s+disabled:\s*true/.test('\n' + r.block))
  if (rows.length === 0) out('✅', '⑤ profile patch 无孪生条目')
  else if (disabledRows.length && intentionallyOff && !bundles.includes(PKG)) {
    // 关键判据：patch 行要「有东西可阻断」才叫故障。bundles 里没有该条目时，
    // 这行是**市场 OFF 的停用记录**，删了它等于删掉「它为什么关着」的证据。
    out('ℹ️', `⑤ profile patch 有 ${rows.length} 条孪生 disabled 行 —— 这是**市场 OFF 的停用记录**（有意停用），不是残渣`,
      rows.map(r => `L${r.line}: ${r.block.split('\n')[0].trim()}`),
      '**别删**：删掉等于删掉停用证据（哪天名字被加回 bundles，这条就是唯一还摁着它的锁）。代价是每次重载会打一条 `patch: entry "dsh-liubian-twin" not found` 噪声——那是本条与「不在 bundles」的必然组合，属预期')
  } else if (disabledRows.length) {
    out('❌', `⑤ profile patch 有 ${rows.length} 条孪生条目（其中 disabled:true ${disabledRows.length} 条）→ **阻断自装配**`,
      rows.map(r => `L${r.line}: ${r.block.split('\n')[0].trim()}`),
      '本 profile patch 自己的注释即写明「disabled 阻断其 bundle patch 自装配」；这类行在，孪生就会不见且日志无错——删掉这些行')
    bad++
  } else {
    out('⚠️', `⑤ profile patch 有 ${rows.length} 条孪生条目（无 disabled 行）`,
      rows.map(r => `L${r.line}: ${r.block.split('\n')[0].trim()}`),
      '这类行只是按 id 的配置覆盖（与插件内 bundle patch 的 id 同名），未能证明有功能影响；要干净可删（共享文件，改前先备份+征得同意）')
  }
  const orphans = (patchText.match(/^-\s+id:\s*[0-9a-f]{8}\s*$/gm) ?? []).length
  if (orphans > 0) lines.push(`    （附注：patch 里还有 ${orphans} 条 8 位哈希 id 行——市场开关写的历史残渣，每次重载都会 'patch: entry ... not found' 噪声）`)
}

// ── ⑥ 市场账本（advisory）与 Desktop 私有停用表（policy）────────────────────
if (manifest !== undefined) {
  const ledger = manifest?.dsh?.desktopDeselectedBundles ?? []
  if (ledger.includes(PKG)) {
    out('⚠️', '⑥ 市场账本 desktopDeselectedBundles 列了孪生' + (bundles.includes(PKG) ? '，但 bundles 里也有它（自相矛盾）' : ''),
      'DSH 的 reconcileDeselectedBundles 会把「已在 bundles」的名字过滤掉，所以当前无害；但账本语义是「Desktop 把它从 bundles 移除过」',
      '可删掉该名字（共享文件，改前备份）；只要 bundles 一直含孪生就不会生效')
    warn++
  } else out('✅', '⑥ 市场账本未列孪生')
}
if (desktopStatePath && existsSync(desktopStatePath)) {
  if (desktopDisabled.includes(PKG)) {
    out('❌', '⑦ Desktop 私有停用表把孪生标停用 → 这是**真正会静默屏蔽**的策略',
      `${desktopStatePath} → profiles[${PROFILE}].disabledBundles`,
      'Desktop 插件页启用，或从该数组删掉（activeDesktopProfileLayers 会直接过滤掉该 bundle 层，日志无错）')
    bad++
  } else out('✅', `⑦ Desktop 私有停用表未屏蔽孪生（本 profile 停用项：${JSON.stringify(desktopDisabled)}）`)
} else if (desktopStatePath) out('✅', '⑦ Desktop 私有停用表不存在（无停用项）')

// ── ⑧ 两个「官方开关」账本自身的一致性（2026-10-01 新增）────────────────────
{
  const onlyMarket = marketDisabled.filter(n => !desktopDisabled.includes(n))
  const onlyDesktop = desktopDisabled.filter(n => !marketDisabled.includes(n))
  if (onlyMarket.length === 0 && onlyDesktop.length === 0) {
    out('✅', `⑧ 两处停用账本一致（市场 ${marketDisabled.length} 项 / Desktop ${desktopDisabled.length} 项）`)
  } else {
    out('⚠️', '⑧ 两处「官方开关」账本互不一致（按错的那个 reconcile 会打架）',
      [
        `市场 state.json disabled（${marketDisabled.length} 项）：${JSON.stringify(marketDisabled)}`,
        `Desktop plugin-management disabledBundles（${desktopDisabled.length} 项）：${JSON.stringify(desktopDisabled)}`,
        ...(onlyMarket.length ? [`只有市场记了停用：${JSON.stringify(onlyMarket)} —— 官方插件页把它们当「启用」`] : []),
        ...(onlyDesktop.length ? [`只有 Desktop 记了停用：${JSON.stringify(onlyDesktop)}`] : []),
      ],
      '这是**市场维护方**的缺陷，不是本插件的问题：市场 OFF 时只写自己的 state.json、没写 Desktop 的账本。报修时把「只有市场记了」的那批一起报')
    warn++
  }
}

// ── 摘要 ───────────────────────────────────────────────────────────────────
console.log(`孪生挂载面体检｜profile=${PROFILE}｜DSH_HOME=${DSH_HOME}`)
console.log(`插件目录 ${PLUGIN_DIR}`)
console.log('')
console.log(lines.join('\n'))
console.log('')
if (bad > 0) console.log(`结论：❌ ${bad} 处需要处理，${warn} 处提醒`)
else if (intentionallyOff) console.log(`结论：ℹ️ 与账本一致 —— 孪生处于**有意停用**态（停用记录：${offLedgers.join('；')}），${warn} 处提醒`)
else console.log(`结论：✅ 四个面一致（${warn} 处提醒）`)
process.exit(bad > 0 ? 1 : 0)
