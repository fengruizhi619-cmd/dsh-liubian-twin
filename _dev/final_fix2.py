#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""收尾：修 1) 安全闸那条用例（makeState 路径没带上开关）2) repair_stray 的"还有残留"断言误判（重编 seq 后与旧的 seq 集合相撞）。"""
import io

# 1) 安全闸用例：显式打开"写会话"，否则新默认（只写 jsonl）会让 "记录进了会话" 失败
p = '_dev/stub_test.mjs'
t = io.open(p, encoding='utf-8').read()
anchor = "  const st = T.makeState()\n  st.turn = 1\n  st.step = 1\n  T.queueRecord("
repl = "  const st = T.makeState()\n  st.recordInSession = true\n  st.turn = 1\n  st.step = 1\n  T.queueRecord("
if anchor in t:
    t = t.replace(anchor, repl, 1)
    io.open(p, 'w', encoding='utf-8', newline='\n').write(t)
    print('stub_test: guard case patched')
else:
    print('stub_test: guard anchor missing（可能已改过）')

# 2) repair_stray：用对象集合判"还有残留"，别用 seq（重编号后会撞）
p2 = '_dev/repair_stray.cjs'
r = io.open(p2, encoding='utf-8').read()
a1 = "const isStray = r => straySeqs.has(r.seq)"
b1 = "const strayObjs = new Set(recs.filter(r => straySeqs.has(r.seq)))\nconst isStray = r => strayObjs.has(r)"
a2 = "if (kept.some(isStray)) throw new Error('还有 turn=999 的记录')"
b2 = "if (kept.some(r => strayObjs.has(r))) throw new Error('还有步外助手消息/自检记录未清干净')"
n = 0
if a1 in r:
    r = r.replace(a1, b1, 1); n += 1
if a2 in r:
    r = r.replace(a2, b2, 1); n += 1
io.open(p2, 'w', encoding='utf-8', newline='\n').write(r)
print('repair_stray: patched blocks =', n)
