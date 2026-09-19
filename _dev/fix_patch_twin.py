#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
修 profile patch 里的 twin 重复 + disabled 残留：
  - id: dsh-liubian-twin / disabled: false
  - id: dsh-liubian-twin / disabled: true     ← 注入器残留（就是它让插件这次没挂上）
两条都删掉（默认就是启用，靠 package.json 的 bundles 装配）。先备份，再回读核对。
"""
import datetime
import io
import re
import shutil

P = r'C:\Users\Feng\.dsh\profiles\desktop\cordis.patch.yml'
s = io.open(P, encoding='utf-8').read()
before = len(re.findall(r'^- id: dsh-liubian-twin', s, re.M))

bak = P + '.bak-twin-dedup-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S')
shutil.copyfile(P, bak)

pat = re.compile(r'(?m)^- id: dsh-liubian-twin\r?\n(?:[ \t]+[^\r\n]*\r?\n)*')
s2 = pat.sub('', s)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s2)

back = io.open(P, encoding='utf-8').read()
after = len(re.findall(r'^- id: dsh-liubian-twin', back, re.M))
print('patch 里 twin 条目：', before, '->', after, '| 备份:', bak)
print('--- 尾部 10 行 ---')
for line in back.split('\n')[-11:]:
    print('  ' + line)
