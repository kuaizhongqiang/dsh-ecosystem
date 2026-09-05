#!/bin/bash
# ============================================================
# dsh 公网白名单补丁（幂等）
# 作用：让公网域名在前端 isLoopback 判定中被视为 loopback，
#       从而解锁配置平面（模型/provider/API key）。
# 用法：
#   export DSH_DOMAIN=<你的公网域名>
#   bash apply-dsh-patch.sh   （在 ~/deepseek-harness 所在机器执行）
# 升级 dsh 后重新运行一次即可自动恢复补丁。
# ============================================================
FILE="$HOME/deepseek-harness/packages/client/connection/src/client/index.ts"
DOMAIN="${DSH_DOMAIN:?请先设置环境变量 DSH_DOMAIN（export DSH_DOMAIN=<你的域名>）}"

OLD="isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),"
NEW="isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname) || pageLocation.hostname === '${DOMAIN}',"

if [ ! -f "$FILE" ]; then
  echo "❌ 找不到文件: $FILE"
  exit 1
fi

if grep -q "$DOMAIN" "$FILE"; then
  echo "✅ 补丁已存在，跳过（无需重复应用）"
elif grep -qF "$OLD" "$FILE"; then
  # 用 python 做精确替换，避免 sed 引号转义问题
  python3 - "$FILE" "$OLD" "$NEW" <<'EOF'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
if old in content:
    content = content.replace(old, new, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("✅ 补丁已应用")
else:
    print("❌ 未找到目标行，请手动检查（上游可能改了代码）")
    sys.exit(1)
EOF
else
  echo "❌ 目标行已不存在，请手动检查（上游可能改了代码）"
  exit 1
fi

echo "--- 当前补丁行 ---"
grep -n "isLoopback:" "$FILE"
