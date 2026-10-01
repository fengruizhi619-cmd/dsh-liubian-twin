/**
 * @dsh-external/dsh-liubian-twin —— 入口壳
 *
 * name / inject 必须静态导出（宿主要读），实现全部放在 impl.mjs，
 * 用 `?t=<时间戳>` 动态导入 —— 绕过 Node ESM 的模块缓存。
 *
 * 为什么需要这个壳：Node 按 **URL** 缓存 ESM 模块，重装配时若用固定路径 import，
 * 拿到的仍是旧模块——改了 code 看着像没生效。带时间戳的 URL 每次都是新模块实例，
 * 所以「apply 被重跑」即等价于「新代码生效」（不需要重启 DSH）。
 *
 * 本插件**不依赖** `@dsh-external/dsh-super-injector`（2026-10-01 管理员指令：全家解耦，
 * 该插件将被删除）：孪生是纯 bundle 装配（profile dependencies `link:` + bundles +
 * 包内 `dsh.bundle.patch`），代码里零 `dev_*` 调用。承重条件两条：① apply 被重跑
 * （bundle 归属走「touch/patch 触发的重装配」，**不要**用已删除的注入器 uninject）；
 * ② 本壳的时间戳在 apply 内求值（见上）。
 *
 * 本文件只在「改 name/inject」时才需要动，且改后需重启 DSH 才会重新读。
 *
 * inject 三项的来由：
 *   tools —— 注册内部工具 `_twin_note`（文本闸门被拒时把纠正回给模型的那条通道）
 *            + 挂 tools/pre-execute 闸门；
 *   llm   —— 监察调用走宿主的 ctx.llm.stream()，同时挂 llm/stream 文本闸门；
 *   agents—— 文本闸门只拿得到 sessionId，要用 ctx.agents.get(sessionId) 找回 agent。
 */
export const name = 'dsh-liubian-twin'
export const inject = ['tools', 'llm', 'agents']

export async function apply(ctx, input = {}) {
  const url = new URL(`./impl.mjs?t=${Date.now()}`, import.meta.url).href
  const impl = await import(url)
  return impl.apply(ctx, input)
}
