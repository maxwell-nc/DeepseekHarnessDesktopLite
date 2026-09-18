# -*- coding: utf-8 -*-
"""验证更新动作：npm install @deepseek-ai/dsh@latest（走镜像 + 已热的缓存）。"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)                                    # <项目根>/src
sys.pycache_prefix = os.path.join(os.path.dirname(SRC), "build", "pycache")
sys.path.insert(0, SRC)

import dsh_shell as sh  # noqa: E402

svc = sh.DshService()
print("镜像源    :", sh.effective_registry() or "(跟随系统)")
print("更新前版本:", svc.installed_version())

t0 = time.time()
ok, output = svc.npm_install(
    sh.PACKAGE + "@latest", lambda line: print("  npm> %s" % line, flush=True)
)
elapsed = time.time() - t0
print("\n结果      :", "成功" if ok else "失败")
print("耗时      : %.1f 秒" % elapsed)
print("更新后版本:", svc.installed_version())
print("---- 输出尾部 ----")
print(output[-600:])
