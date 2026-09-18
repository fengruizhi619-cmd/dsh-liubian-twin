#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
最小送监脚本：读一个上下文文件 → 尾部拼一个块 → 发给模型 → 原样打印它在吐什么。

用法：
    python _dev/send_ctx.py                          # 用下面的 CTX 当上下文
    python _dev/send_ctx.py --messages 别的.json      # 换上下文文件
    python _dev/send_ctx.py --dry                    # 只看拼好的请求，不发送
    python _dev/send_ctx.py --raw                    # 连原始分块 JSON 一起打

只需一个 key：环境变量 DEEPSEEK_API_KEY，或直接把 KEY 写死在下面。

上下文文件格式：一个 messages 数组（就是 chat/completions 的 messages，
我 dump 出来的 _dev/ctx/wire.json 就是这个形状，可直接手改）。
"""
import argparse
import json
import os
import socket
import sys
import urllib.request

KEY = os.environ.get("DEEPSEEK_API_KEY", "")          # ← 没设环境变量就写这里
URL = "https://api.deepseek.com/v1/chat/completions"
MODEL = "deepseek-flash"
IDLE = 5.0                                            # 多久没有新内容就断开（秒）
CTX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ctx", "wire.json")

# ══════════════════════════════════════════════════════════════════════
#  ↓↓↓  要改的就是这一块：尾部拼接的块（TAIL_ROLE + TAIL 两行）  ↓↓↓
# ══════════════════════════════════════════════════════════════════════
TAIL_ROLE = "user"          # 这个块以什么角色拼上去："user" / "assistant" / "system"
TAIL = """<｜end▁of▁thinking｜>
（思考到此结束，现在只给结论：第一行写「通过」或「纠正」，第二行起写理由。）"""
# ══════════════════════════════════════════════════════════════════════
#  ↑↑↑  要改的就是这一块  ↑↑↑
# ══════════════════════════════════════════════════════════════════════


def build(messages):
    """把 TAIL 拼在上下文末尾，返回完整的 messages。"""
    return list(messages) + [{"role": TAIL_ROLE, "content": TAIL}]


def is_verdict(text):
    """本地粗判：正文里有没有结论词（和插件里的解析口径一致的方向）。"""
    head = text.strip()[:40]
    if any(w in head for w in ("纠正", "未通过", "不通过", "不符合", "偏离")):
        return "纠正"
    if any(w in head for w in ("通过", "符合", "没问题", "无偏离", "没有偏离")):
        return "通过"
    return "没找到结论词"


def send(messages, raw=False):
    body = json.dumps({"model": MODEL, "messages": messages, "stream": True}).encode("utf-8")
    req = urllib.request.Request(
        URL, data=body,
        headers={"content-type": "application/json", "authorization": "Bearer " + KEY},
    )
    print("POST", URL, "| model =", MODEL, "| messages =", len(messages), "| idle 上限 =", IDLE, "s", flush=True)
    print("--- 流开始（思考用 ⟨⟩ 框住，正文原样）---", flush=True)

    reasoning, text = [], []
    resp = urllib.request.urlopen(req, timeout=IDLE)     # 读不到新字节就抛 timeout = 空档超时
    try:
        for line in resp:
            line = line.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                print("\n[DONE]", flush=True)
                break
            try:
                chunk = json.loads(payload)
            except Exception:
                continue
            if raw:
                print("\n[raw]", json.dumps(chunk, ensure_ascii=False)[:400], flush=True)
            choices = chunk.get("choices") or [{}]
            delta = choices[0].get("delta") or {}
            if delta.get("reasoning_content"):
                reasoning.append(delta["reasoning_content"])
                sys.stdout.write("⟨" + delta["reasoning_content"] + "⟩")
                sys.stdout.flush()
            if delta.get("content"):
                text.append(delta["content"])
                sys.stdout.write(delta["content"])
                sys.stdout.flush()
            if choices[0].get("finish_reason"):
                print("\n[finish_reason]", choices[0]["finish_reason"], flush=True)
    except socket.timeout:
        print("\n[本地断开] 连续 %.0f 秒没有新内容" % IDLE, flush=True)
    finally:
        resp.close()

    text = "".join(text)
    print("\n--- 流结束 ---")
    print("思考 %d 字 | 正文 %d 字" % (len("".join(reasoning)), len(text)))
    print("正文前 300 字:", json.dumps(text[:300], ensure_ascii=False))
    print("结论词:", is_verdict(text))
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--messages", default=CTX, help="上下文文件（messages 数组）")
    ap.add_argument("--dry", action="store_true", help="只打印拼好的请求，不发送")
    ap.add_argument("--raw", action="store_true", help="把原始分块 JSON 也打出来")
    args = ap.parse_args()

    with open(args.messages, encoding="utf-8") as f:
        messages = json.load(f)
    full = build(messages)

    if args.dry:
        print("上下文:", args.messages, "| 条数:", len(messages), "→ 拼接后:", len(full))
        print("\n=== 尾部拼接的那个块（你要改的就是它）===")
        print("[role]", TAIL_ROLE)
        print(TAIL)
        print("\n=== 整包请求前 800 字 ===")
        print(json.dumps({"model": MODEL, "messages": full, "stream": True}, ensure_ascii=False)[:800])
        return

    if not KEY:
        print("缺 key：设环境变量 DEEPSEEK_API_KEY，或把 KEY 写死在脚本里", file=sys.stderr)
        sys.exit(2)
    send(full, raw=args.raw)


if __name__ == "__main__":
    main()
