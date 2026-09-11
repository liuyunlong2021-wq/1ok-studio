#!/usr/bin/env python3
"""读 SSE 流并打印到达时间线，用来判断上游到底是「真流式」还是「攒完一次性吐」。

用法（配合 curl，可以直接比 Cloudflare 和源站两条路）：

    # 经 Cloudflare
    curl -sS -N -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d '{"model":"gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":"写 600 字"}]}' \
      https://api.jiucaihezi.studio/v1/chat/completions | python3 scripts/probe_llm_stream.py

    # 直连源站（用 --resolve 绕过 Cloudflare，证书仍按 api.jiucaihezi.studio 校验）
    curl -sS -N --resolve api.jiucaihezi.studio:443:47.82.86.196 ... 同上

输出里如果所有 chunk 的时间戳都一样（等于总耗时），说明中间被缓冲了，流式救不了。
"""
import sys
import time

t0 = time.time()
chunks = 0
text_len = 0
marked = False

for raw in sys.stdin:
    line = raw.strip()
    if not line.startswith("data:"):
        if line and chunks == 0:
            print(f"[{time.time() - t0:6.1f}s] 非 SSE 内容: {line[:120]}", flush=True)
        continue
    payload = line[5:].strip()
    if payload == "[DONE]":
        print(f"[{time.time() - t0:6.1f}s] [DONE]", flush=True)
        continue
    chunks += 1
    # 记录前 3 个和每隔 20 个 chunk 的到达时间
    if chunks <= 3 or chunks % 20 == 0:
        print(f"[{time.time() - t0:6.1f}s] chunk #{chunks} len={len(payload)}", flush=True)
    if chunks > 3:
        marked = True

print(f"--- 共 {chunks} chunk，耗时 {time.time() - t0:.1f}s ---", flush=True)
