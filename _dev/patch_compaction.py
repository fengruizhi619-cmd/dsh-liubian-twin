#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把压缩触发点改成"窗口 70% 固定触发"：往 profile patch 里加一条 compaction-basic 的 config 覆盖。
先备份；已存在则跳过。打印改后的 patch 头部供核对。

    E:\\python\\python.exe _dev/patch_compaction.py
"""
import datetime
import io
import os
import shutil

P = r'C:\Users\Feng\.dsh\profiles\desktop\cordis.patch.yml'
s = io.open(P, encoding='utf-8').read()

if 'compaction-basic' in s:
    print('已存在 compaction-basic 覆盖，未改动')
else:
    bak = P + '.bak-compaction-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S')
    shutil.copyfile(P, bak)
    block = (
        '# 压缩触发点（管理：用户指定）：按窗口 70% 固定触发。\n'
        '# 默认 thresholdRatio 0.8 = 贴到窗口边缘才压，会出现 "maximum context length" 越线报错；\n'
        '# 0.7 表示会话涨到约 73.4 万 token（1,048,576 × 0.7）就固定压一次。\n'
        '- id: compaction-basic\n'
        '  config:\n'
        '    thresholdRatio: 0.7\n'
        '\n'
    )
    marker = '# 注入器默认扫描'
    i = s.index(marker)
    s = s[:i] + block + s[i:]
    io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
    print('已写入。备份:', bak)

print('--- 改后 patch 头部 14 行 ---')
for line in io.open(P, encoding='utf-8').read().split('\n')[:14]:
    print('  ' + line)
