#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
去上游官方仓库把"消息是怎么被拼成带阶段标记的文本"的那段代码抓下来（这是唯一能看到
真正标记的地方：DSH 只发结构化 messages，标记是上游模板加的）。
只下载 encoding/chat_template 类文件，并把含标记的行按码点打印（不打印原文字面量）。

    python _dev/fetch_template.py
"""
import json
import os
import re
import urllib.request

REPOS = ["deepseek-ai/DeepSeek-V3.2", "pipenetwork/DeepSeek-V4-Flash-MLX-4bit", "deepseek-ai/DeepSeek-V3.1"]
BASES = ["https://hf-mirror.com", "https://huggingface.co"]
BASE = BASES[0]      # 直连 huggingface.co 在本机超时；默认走镜像
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hf")
BAR = "\uff5c"   # 全角竖线
SEP = "\u2581"   # ▁


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"user-agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def codes(s):
    return "".join(ch if ord(ch) < 128 else "U+%04X" % ord(ch) for ch in s)


def main():
    os.makedirs(OUT, exist_ok=True)
    for repo in REPOS:
        print("=" * 70)
        print("仓库:", repo)
        try:
            meta = json.loads(get(BASE + "/api/models/" + repo))
        except Exception as e:
            print("  取文件列表失败:", e)
            continue
        names = [s["rfilename"] for s in meta.get("siblings", [])]
        picks = [n for n in names if re.search(r"encoding|chat_template|tokenizer_config|template", n, re.I)]
        print("  候选文件:", picks or "(无)")
        for name in picks[:4]:
            try:
                raw = get(BASE + "/%s/raw/main/%s" % (repo, name))
            except Exception as e:
                print("  下载失败", name, e)
                continue
            text = raw.decode("utf-8", "replace")
            local = os.path.join(OUT, repo.replace("/", "__") + "__" + name.replace("/", "_"))
            with open(local, "wb") as f:
                f.write(raw)
            print("  ── %s（%d 字，已存 %s）" % (name, len(text), os.path.basename(local)))
            hits = 0
            for line in text.split("\n"):
                if (BAR in line or SEP in line or "thinking" in line.lower()) and hits < 18:
                    hits += 1
                    print("     " + codes(line.strip())[:200])
            if not hits:
                print("     （没有含标记/thinking 的行）")


if __name__ == "__main__":
    main()
