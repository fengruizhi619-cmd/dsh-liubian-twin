/**
 * @dsh-external/dsh-liubian-twin —— 入口壳
 *
 * name / inject 必须静态导出（宿主要读），实现全部放在 impl.mjs，
 * 用 `?t=<时间戳>` 动态导入 —— 绕过 Node ESM 的模块缓存。
 *
 * 为什么需要这个壳：插件是「热注入」的（super-injector 建 junction + loader 加载），
 * 但 Node 按 URL 缓存 ESM 模块，反注入再注入拿到的仍是旧模块，改了代码不生效。
 * 有了这个壳，之后改 impl.mjs 就能真正热生效，不需要重启 DSH。
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
