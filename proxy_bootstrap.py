#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
供 node 脚本调用的代理启动器（常驻子进程）。
- stdout 只输出一行 JSON：{"proxy_url": ..., "exit_ip": ..., "mode": ...}
  或 {"error": "..."}；node 读到第一行即知启动结果
- node_proxy.py 的过程日志重定向到 stderr
- 启动成功后进程常驻（node 结束时 kill 掉，atexit 会清理 sing-box）
"""
import contextlib
import io
import json
import os
import signal
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    # SIGTERM 默认不会触发 atexit；显式转成 SystemExit，
    # 让 node_proxy.py 的 atexit 清理掉 sing-box 子进程（本地跑不会残留）
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    from node_proxy import setup_node_proxy
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            proxy_url, exit_ip, mode = setup_node_proxy(
                os.environ.get("NODE_LINK", ""), workdir=".")
    except Exception as e:
        sys.stderr.write(buf.getvalue())
        sys.stderr.flush()
        print(json.dumps({"error": str(e)[:300]}), flush=True)
        return 1
    sys.stderr.write(buf.getvalue())
    sys.stderr.flush()
    print(json.dumps({"proxy_url": proxy_url, "exit_ip": exit_ip, "mode": mode}),
          flush=True)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    sys.exit(main())
