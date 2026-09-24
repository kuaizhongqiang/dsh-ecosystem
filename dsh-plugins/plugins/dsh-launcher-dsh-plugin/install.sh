#!/usr/bin/env bash
# dsh-launcher —— launcher 桥接合并包（PM3；依赖 launcher M5/M6 seam）。
#
# Linux / macOS 版安装器（与 install.ps1 等价）。为什么需要它：插件包原先只带
# install.ps1，非 Windows 机器没有可执行的安装路径，只能手工拷载荷 + 编辑 patch。
#
# 用法：
#   ./install.sh                 安装（幂等，可重复执行）
#   ./install.sh --uninstall     卸载（删载荷 + 剥 patch 节）
#   DSH_HOME=/path ./install.sh  指定 DSH_HOME（缺省 ~/.dsh）
#   ./install.sh --profile /x/profiles/web   直接指定 web profile 目录
#
# 说明：载荷是纯 JS（跨平台）；本包不需要任何凭证，seam 全在 %DSH_HOME% 文件与
# DSH_LAUNCHER_EXE 环境变量里。

set -euo pipefail

PKG='dsh-launcher'
SVC='launcher'
TOOL_ID='tool-launcher'
SECTION_HEADER="${PKG}: ${SVC}"

UNINSTALL=0
PROFILE_DIR=''
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    --profile) PROFILE_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$PROFILE_DIR" ]; then
  DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
  PROFILE_DIR="$DSH_HOME/profiles/web"
fi
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
PLUGIN_DIR="$PROFILE_DIR/plugins/$SVC"

if [ "$UNINSTALL" -eq 0 ]; then
  if [ ! -d "$(dirname "$PROFILE_DIR")" ]; then
    echo "ERROR: 没有找到 dsh profiles 目录（$PROFILE_DIR 的上级）。dsh 装了吗？" >&2
    exit 1
  fi
  if [ ! -d "$PROFILE_DIR" ]; then
    echo "ERROR: web profile 不存在：$PROFILE_DIR（先跑一次 dsh web 初始化）" >&2
    exit 1
  fi
fi

# 从 patch 里精确剥掉本节：节头注释块 + 紧随其后的那一个 insert 条目（不碰别的节）。
strip_section() {
  awk -v HDR="$SECTION_HEADER" '
    BEGIN { skip = 0; ins = 0 }
    {
      if (skip == 0 && ins == 0 && $0 ~ /^[[:space:]]*#[[:space:]]*---/ && index($0, HDR) > 0) { skip = 1; next }
      if (skip == 1) {
        if ($0 ~ /^[[:space:]]*#/) { next }
        if ($0 ~ /^[[:space:]]*$/) { next }
        if ($0 ~ /^[[:space:]]*-[[:space:]]*insert:/) { ins = 1; skip = 0; next }
        skip = 0
      }
      if (ins == 1) {
        if ($0 ~ /^[[:space:]]/ || $0 ~ /^[[:space:]]*-/) { next }
        ins = 0
      }
      print
    }
  ' "$1"
}

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -d "$PLUGIN_DIR" ]; then
    rm -rf "$PLUGIN_DIR"
    echo "OK  已删除 $PLUGIN_DIR"
  fi
  if [ -f "$PATCH_FILE" ]; then
    tmp="$(mktemp)"
    strip_section "$PATCH_FILE" > "$tmp"
    # 去掉尾部空行后写回（保持无 BOM / LF）
    printf '%s\n' "$(cat "$tmp")" > "$PATCH_FILE"
    rm -f "$tmp"
    echo "OK  已剥离 patch 节（$SECTION_HEADER）"
  fi
  echo "dsh-launcher 插件已卸载。请重启 web 实例。"
  exit 0
fi

# 1. 拷载荷
mkdir -p "$PLUGIN_DIR"
for f in index.js package.json; do
  src="$here/plugins/$SVC/$f"
  [ -f "$src" ] || { echo "ERROR: 缺少载荷文件 $src" >&2; exit 1; }
  cp -a "$src" "$PLUGIN_DIR/$f"
done
echo "OK  载荷已拷贝 -> $PLUGIN_DIR"

# 2. 写 patch 条目（按 tool-launcher 幂等）
touch "$PATCH_FILE"
if grep -q "$TOOL_ID" "$PATCH_FILE"; then
  echo "SKIP $TOOL_ID 已存在于 $PATCH_FILE"
else
  tmp="$(mktemp)"
  # 去掉 dsh 初始化时留下的裸 [] 占位行，避免追加后 YAML 变成两个文档
  grep -vE '^[[:space:]]*\[\][[:space:]]*$' "$PATCH_FILE" > "$tmp" || true
  {
    cat "$tmp"
    printf '\n# --- %s (native dsh) ---\n' "$SECTION_HEADER"
    printf '# Launcher seam tools: restart/status/connections/open/check_update (M5/M6 discovery chain).\n'
    printf -- '- insert:\n'
    printf '    - id: %s\n' "$TOOL_ID"
    printf "      name: './plugins/%s/index.js'\n" "$SVC"
  } > "$PATCH_FILE"
  rm -f "$tmp"
  echo "OK  已写入 profile patch 条目（$TOOL_ID）-> $PATCH_FILE"
fi

# 3. 写后校验（有校验器就跑；不通过必须让人看见，别等重启才发现）
VALIDATOR="$PROFILE_DIR/validate-patch.mjs"
[ -f "$VALIDATOR" ] || VALIDATOR="$(cd "$here/../../.." 2>/dev/null && pwd)/dsh-plugins/scripts/validate-patch.mjs"
if [ -f "$VALIDATOR" ] && command -v node >/dev/null 2>&1; then
  echo
  node "$VALIDATOR" "$PATCH_FILE" || { echo "ERROR: patch 校验未通过，请先修好再重启" >&2; exit 1; }
fi

cat <<'EOF'

下一步：
  1. 重启 web 实例（工具在重启后可见）：停掉再 `dsh web`；
     若已有 launcher 注册，也可沿用 launcher_restart。
  2. 不需要任何凭证：这些工具只读 %DSH_HOME% 下的 seam 文件（token 不出本机）。
  3. 非 Windows 上 launcher_restart/open 依赖 launcher 本体；没有 launcher 时
     只有 launcher_cli（装/升级 dsh-cli）能用，其余会给出明确报错。
EOF
