#!/bin/bash
# ============================================================
# dsh 服务重启脚本（幂等）
# 用途：停止旧 dsh 进程并启动新进程（加载新构建产物）
# 用法：
#   export DSH_DOMAIN=<你的公网域名>
#   bash restart-dsh.sh
# ============================================================
DOMAIN="${DSH_DOMAIN:?请先设置环境变量 DSH_DOMAIN（export DSH_DOMAIN=<你的域名>）}"

PID=$(ss -tlnp 2>/dev/null | grep ':3080 ' | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$PID" ]; then
  echo "停止旧进程 pid=$PID"
  kill "$PID"
  sleep 3
  # 确认已停止
  if ss -tlnp 2>/dev/null | grep -q ':3080 '; then
    echo "进程仍在，强制终止"
    kill -9 "$PID" 2>/dev/null
    sleep 2
  fi
else
  echo "无旧进程在监听 3080"
fi

cd ~/deepseek-harness/apps/cli || exit 1
nohup /usr/bin/node lib/bin.js web --host 127.0.0.1 --port 3080 --no-open --trusted-host "$DOMAIN" >> ~/logs/dsh.log 2>&1 &
sleep 6

echo "--- 监听状态 ---"
ss -tlnp 2>/dev/null | grep 3080
echo "--- 本地 curl ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 8 http://localhost:3080/
echo "--- 日志尾部 ---"
tail -3 ~/logs/dsh.log
