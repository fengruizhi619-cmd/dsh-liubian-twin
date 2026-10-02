// 流变·孪生 面板（client 半，v3 M2-b）：
//  - 在对话页注册「孪生」页签（conversation.view 列表槽，order 20，排在对话/轨迹之间）；
//  - 渲染影子会话的消息面：孪生自己投递的指令消息折叠成一行（带 summary），监督回复正常展开；
//  - 数据走本插件宿主只读路由 /api/liubian-twin（shadowRead / shadowStatus）。
//
// ⚠ 生效判据（家族校正过的口径）：client 字节是**注册时快照**（dsh-client-modules 的
//   reconcilePackage 在 sourceKey 未变时直接 return）——改这个文件必须重装配（touch profile
//   patch）或重启才生效，F5 无效；判定只认宿主日志版本戳。
//
// ⚠ 预登记的未验证点（v3 文档 §4）：宿主 renderSlot 把 conversation.view occupant 渲染为
//   组件时，entry.inject(sessionId) 的返回值如何并入 props **未实证**（renderSlot 的创建
//   闭包在宿主更外层，不在 client-ui-conversation 包内）。本组件做防御式读取：
//   props.twinSessionId ?? props.sessionId，拿不到就显示明确的降级提示而不是装作正常。
window.__ModuleLoader__.load({
  id: 'dsh-liubian-twin',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement

    var CSS = [
      '.twin-panel{height:100%;overflow-y:auto;box-sizing:border-box;padding:18px 28px 28px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
      '.twin-empty{color:var(--dsw-alias-label-tertiary);padding:32px 0;text-align:center}',
      '.twin-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:8px 12px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;margin:0 0 14px}',
      '.twin-msg{margin:0 0 14px;border-radius:10px;padding:10px 14px;box-sizing:border-box;max-width:860px}',
      '.twin-msg.is-user{background:var(--dsw-alias-interactive-bg-hover)}',
      '.twin-msg.is-assistant{background:var(--dsw-specific-input-major)}',
      '.twin-role{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}',
      '.twin-text{white-space:pre-wrap;word-break:break-word}',
      '.twin-directive{color:var(--dsw-alias-label-tertiary)}',
      '.twin-directive>summary{cursor:pointer;user-select:none}',
      '.twin-directive>summary:hover{color:var(--dsw-alias-label-secondary)}',
      '.twin-error{color:#c0392b;font-size:13px}',
    ].join('\n')

    function MsgItem(m) {
      if (m.directive) {
        // 孪生的投递指令：默认折叠，点开才看全文（它不是给人读的正文）。
        return h('details', { className: 'twin-msg is-user twin-directive', key: m.key },
          h('summary', null, '孪生投递：' + (m.summary || '（无摘要）')),
          h('div', { className: 'twin-text', style: { marginTop: '6px' } }, m.text),
        )
      }
      return h('div', { className: 'twin-msg is-' + (m.role === 'user' ? 'user' : 'assistant'), key: m.key },
        h('div', { className: 'twin-role' }, m.role === 'user' ? '用户（被监督对话）' : '孪生'),
        h('div', { className: 'twin-text' }, m.text),
      )
    }

    function TwinPanel(props) {
      // 防御式取当前会话 id：正常路径 = entry.inject(sessionId) 的返回并入 props；
      // 拿不到就诚实显示降级提示（预登记判据，见文件头注）。
      var sid = (props && (props.twinSessionId || props.sessionId)) || null
      var state = React.useState({ loading: true, error: '', note: '', messages: [], shadowId: null })
      var data = state[0], setData = state[1]

      React.useEffect(function () {
        if (!sid) { setData({ loading: false, error: '', note: '', messages: [], shadowId: null, noSid: true }); return undefined }
        var alive = true
        var load = function () {
          fetch('/api/liubian-twin?op=shadowRead&sessionId=' + encodeURIComponent(sid) + '&limit=200')
            .then(function (r) { return r.json() })
            .then(function (j) {
              if (alive) setData({
                loading: false,
                error: j.error || '',
                note: j.note || '',
                messages: Array.isArray(j.messages) ? j.messages : [],
                shadowId: j.shadowId || null,
              })
            })
            .catch(function (e) {
              if (alive) setData({ loading: false, error: '宿主路由不可达（孪生插件未挂载？）：' + String(e && e.message ? e.message : e), note: '', messages: [], shadowId: null })
            })
        }
        load()
        var t = setInterval(load, 5000)
        return function () { alive = false; clearInterval(t) }
      }, [sid])

      if (!sid) {
        return h('div', { className: 'twin-panel' },
          h('style', null, CSS),
          h('div', { className: 'twin-empty' },
            '无法定位当前会话（页签组件没有收到 sessionId）。',
            h('div', { className: 'twin-error', style: { marginTop: '8px' } },
              '这是 v3 预登记的未验证点：宿主 renderSlot 对组件项的 inject 合并口径未实证——请把此提示反馈给维护者，改用服务端注入 sessionId 的形态。'),
          ),
        )
      }
      if (data.loading) return h('div', { className: 'twin-panel' }, h('style', null, CSS), h('div', { className: 'twin-empty' }, '加载中…'))
      if (data.error) return h('div', { className: 'twin-panel' }, h('style', null, CSS), h('div', { className: 'twin-error' }, data.error))
      if (!data.shadowId || !data.messages.length) {
        return h('div', { className: 'twin-panel' }, h('style', null, CSS),
          data.note ? h('div', { className: 'twin-note' }, data.note) : null,
          h('div', { className: 'twin-empty' }, '本会话暂无孪生消息'),
        )
      }
      return h('div', { className: 'twin-panel' }, h('style', null, CSS),
        h('div', { className: 'twin-note' }, '孪生影子会话 ' + String(data.shadowId).slice(0, 22) + '…（只读视图；每 5 秒刷新）'),
        data.messages.map(function (m, i) { return MsgItem(Object.assign({}, m, { key: i })) }),
      )
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        // 注册即挂具：slots.inject 的返回值（去注册函数）作为 effect 清理——
        // 插件卸载时页签随 effect 释放（trajectory 同款）。
        ctx.effect(function () {
          return ctx.slots.inject('conversation.view', function () {
            return ctx.slots.register({
              name: 'conversation.view',
              id: 'twin',
              order: 20,
              label: '孪生',
              inject: function (sessionId) { return { twinSessionId: sessionId } },
            }, TwinPanel)
          })
        }, 'twin: conversation.view tab')
      },
    }
  },
})
