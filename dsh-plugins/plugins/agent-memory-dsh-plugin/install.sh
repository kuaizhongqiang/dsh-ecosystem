#!/usr/bin/env bash
# agent-memory-dsh-plugin —— Linux/macOS 安装器（dsh-ecosystem）
#
# 两种接入模式：
#   native（默认）一个原生 cordis 插件 `tool-agent-memory`：11 个工具（主记忆 3 + 代码图谱 8）
#                 + **进程内自动入库**（turn/end → L0）。不需要 npx/MCP 子进程，不需要守护。
#   mcp           保持原两条 MCP 通道（mcp-agent-memory / mcp-agent-memory-codegraph）
#                 + 可选外部 autostore 守护（适合无插件能力的 headless 场景）。
#
# 服务（--only，缺省随模式）：
#   native 模式缺省 memory,codegraph；autostore 仅在你显式指定时才装外部守护。
#   mcp    模式缺省 memory,codegraph,autostore。
#   engine 第三方引擎的 systemd 单元模板渲染（需另有引擎检出，见 README）。
#
# 用法：
#   ./install.sh                                   # native 模式
#   ./install.sh --mode mcp                        # 回退 MCP 模式
#   ./install.sh --only memory,codegraph           # 子集
#   ./install.sh --only autostore                  # 只要外部守护（native 模式下也可）
#   ./install.sh --only engine --engine-dir /path  # 渲染引擎单元模板
#   ./install.sh --uninstall                       # 卸载（两种模式的产物都会清）
#   ./install.sh --no-start                        # 只装不 enable/start（守护）
#   ./install.sh --dry-run                         # 只打印将执行的动作
#
# 幂等：载荷覆盖复制；cordis.patch.yml 按标记块增删；模式切换会移除另一模式的条目（避免重复工具）。
# 凭证：本脚本不写任何密钥；身份三元组/团队 key 由你在 cordis.patch.yml 的 config 里填（见 .env.example）。
set -euo pipefail

MODE="native"
ONLY=""
UNINSTALL=0
NO_START=0
DRY=0
PROFILE_DIR="${PROFILE_DIR:-}"
REPO_ROOT="${REPO_ROOT:-}"
ENGINE_DIR="${ENGINE_DIR:-$HOME/projects/TencentDB-Agent-Memory}"
MEMORY_HOME="${MEMORY_HOME:-$HOME/.openclaw/memory-tdai}"

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --only=*) ONLY="${1#*=}"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --profile-dir) PROFILE_DIR="${2:-}"; shift 2 ;;
    --repo-root) REPO_ROOT="${2:-}"; shift 2 ;;
    --engine-dir) ENGINE_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "ERROR: 未知参数 $1（--help 查看用法）" >&2; exit 1 ;;
  esac
done

case "$MODE" in native|mcp) ;; *) echo "ERROR: --mode 只能是 native 或 mcp（收到 '$MODE'）" >&2; exit 1 ;; esac
if [ -z "$ONLY" ]; then
  if [ "$MODE" = native ]; then ONLY="memory,codegraph"; else ONLY="memory,codegraph,autostore"; fi
fi

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -z "$REPO_ROOT" ] && REPO_ROOT="$(cd "$PKG_DIR/../../.." && pwd)"
AM_DIR="$REPO_ROOT/agent-memory"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
[ -z "$PROFILE_DIR" ] && PROFILE_DIR="$DSH_HOME/profiles/web"
PATCH="$PROFILE_DIR/cordis.patch.yml"
PLUGINS_DIR="$PROFILE_DIR/plugins"
NATIVE_DIR="$PLUGINS_DIR/agent-memory-native"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE_BIN="$(command -v node || true)"
MARK="agent-memory-dsh-plugin"

ALL="memory codegraph autostore engine"
for s in ${ONLY//,/ }; do
  case " $ALL " in *" $s "*) ;; *) echo "ERROR: 未知服务 '$s'。可用: $ALL" >&2; exit 1 ;; esac
done
has() { case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
run() { if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }
info() { echo "  $*"; }

echo "== agent-memory-dsh-plugin =="
echo "  包目录  : $PKG_DIR"
echo "  伞仓根  : $REPO_ROOT"
echo "  profile : $PROFILE_DIR"
echo "  mode    : $MODE$([ "$UNINSTALL" = 1 ] && echo '  (uninstall)')"
echo "  services: $ONLY"

# --- cordis.patch.yml 标记块增删 ---------------------------------------------
patch_has() { [ -f "$PATCH" ] && grep -q "id: $1$" "$PATCH"; }

patch_add() { # $1=id  $2=block
  local id="$1" body="$2"
  patch_has "$id" && { info "SKIP patch $id (已存在)"; return 0; }
  if [ "$DRY" = 1 ]; then echo "  [dry-run] 追加 cordis 条目 $id"; return 0; fi
  mkdir -p "$(dirname "$PATCH")"
  {
    echo ""
    echo "# >>> $MARK: $id >>>"
    printf '%s\n' "$body"
    echo "# <<< $MARK: $id <<<"
  } >> "$PATCH"
  info "OK  patch 条目已追加: $id"
}

patch_del() { # $1=id —— 只删本包管理的标记块；他人同名块只提示不动
  local id="$1"
  patch_has "$id" || return 0
  if ! grep -q "^# >>> $MARK: $id >>>$" "$PATCH"; then
    info "SKIP patch $id（存在于他人管理的块中，未改动）"
    return 0
  fi
  if [ "$DRY" = 1 ]; then echo "  [dry-run] 移除 cordis 条目 $id"; return 0; fi
  awk -v id="$id" -v MARK="$MARK" '
    $0 ~ ("^# >>> " MARK ": " id " >>>$") { skip=1; next }
    $0 ~ ("^# <<< " MARK ": " id " <<<$") { skip=0; next }
    skip != 1 { print }
  ' "$PATCH" > "$PATCH.tmp" && mv "$PATCH.tmp" "$PATCH"
  info "OK  patch 条目已移除: $id"
}

# --- 卸载 ---------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  echo "-- uninstall"
  patch_del tool-agent-memory
  patch_del mcp-agent-memory
  patch_del mcp-agent-memory-codegraph
  [ -d "$NATIVE_DIR" ] && run "rm -rf '$NATIVE_DIR'"
  [ -d "$PLUGINS_DIR/agent-memory-codegraph" ] && run "rm -rf '$PLUGINS_DIR/agent-memory-codegraph'"
  UNIT="$SYSTEMD_DIR/dsh-memory-autostore.service"
  if [ -f "$UNIT" ]; then
    run "systemctl --user disable --now dsh-memory-autostore.service || true"
    run "rm -f '$UNIT'"
    run "systemctl --user daemon-reload || true"
    info "已移除 autostore 守护（state 文件保留）"
  fi
  echo "== 完成（记忆数据 ~/.openclaw/memory-tdai 未动） =="
  exit 0
fi

# --- native 模式 ---------------------------------------------------------------
if [ "$MODE" = native ]; then
  if has memory || has codegraph; then
    echo "-- native 插件（memory + codegraph + 进程内入库）"
    [ -d "$PKG_DIR/plugins/agent-memory-native" ] || { echo "ERROR: 缺少 plugins/agent-memory-native" >&2; exit 1; }
    run "mkdir -p '$PLUGINS_DIR'"
    run "rm -rf '$NATIVE_DIR'"
    run "cp -R '$PKG_DIR/plugins/agent-memory-native' '$NATIVE_DIR'"
    # 模式切换：移除 MCP 两条通道（避免同名工具重复）；只移除本包自己管理的块
    patch_del mcp-agent-memory
    patch_del mcp-agent-memory-codegraph
    patch_add tool-agent-memory "$(cat <<EOF
- insert:
    - id: tool-agent-memory
      name: './plugins/agent-memory-native/index.js'
      config:
        memoryEndpoint: http://127.0.0.1:8422
        knowledgeEndpoint: http://127.0.0.1:8421
        apiKey: '<bridge api key>'
        serviceId: default
        teamId: '<TEAM_ID>'
        agentId: '<AGENT_ID>'
        userId: '<USER_ID>'
        userKey: '<sk-mem-...>'
        taskId: '<project label task_id>'
        capture: true
        timeoutMs: 15000
EOF
)"
    info "记得把 config 里的 <...> 占位符换成真实值（见 .env.example / README）"
    info "native 模式下入库在进程内完成，无需 autostore 守护"
  fi
fi

# --- mcp 模式 -----------------------------------------------------------------
if [ "$MODE" = mcp ]; then
  if has codegraph; then
    echo "-- mcp: codegraph"
    run "mkdir -p '$PLUGINS_DIR'"
    run "rm -rf '$PLUGINS_DIR/agent-memory-codegraph'"
    run "cp -R '$PKG_DIR/plugins/agent-memory-codegraph' '$PLUGINS_DIR/agent-memory-codegraph'"
    patch_del tool-agent-memory
    patch_add mcp-agent-memory-codegraph "$(cat <<EOF
- insert:
    - id: mcp-agent-memory-codegraph
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-memory-codegraph
        transport: stdio
        command: node
        args: ['$PLUGINS_DIR/agent-memory-codegraph/index.mjs']
        env:
          KNOWLEDGE_ENDPOINT: 'http://127.0.0.1:8421'
          SERVICE_ID: default
          TEAM_ID: '<TEAM_ID>'
          USER_ID: '<USER_ID>'
          AGENT_ID: '<AGENT_ID>'
        toolCallTimeoutMs: 30000
EOF
)"
  fi
  if has memory; then
    echo "-- mcp: memory"
    patch_del tool-agent-memory
    patch_add mcp-agent-memory "$(cat <<EOF
- insert:
    - id: mcp-agent-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-memory
        transport: stdio
        command: npx
        args: ['-y', 'tencent-agent-memory-mcp-bridge@0.4.0']
        env:
          MEMORY_ENDPOINT: http://127.0.0.1:8422
          API_KEY: '<bridge api key>'
          SERVICE_ID: default
          TEAM_ID: '<TEAM_ID>'
          AGENT_ID: '<AGENT_ID>'
          USER_ID: '<USER_ID>'
          USER_KEY: '<sk-mem-...>'
          TASK_ID: '<project label task_id>'
        toolCallTimeoutMs: 30000
EOF
)"
    info "记得把 env 里的 <...> 占位符换成真实值"
  fi
fi

# --- autostore（外部守护，两种模式都可显式安装） --------------------------------
if has autostore; then
  echo "-- autostore 守护"
  UNIT="$SYSTEMD_DIR/dsh-memory-autostore.service"
  [ -f "$AM_DIR/scripts/dsh-memory-autostore.mjs" ] || { echo "ERROR: 找不到 $AM_DIR/scripts/dsh-memory-autostore.mjs（--repo-root 是否指向伞仓根？）" >&2; exit 1; }
  [ -n "$NODE_BIN" ] || { echo "ERROR: PATH 里找不到 node" >&2; exit 1; }
  run "mkdir -p '$SYSTEMD_DIR'"
  if [ "$DRY" = 1 ]; then
    echo "  [dry-run] 写 $UNIT (WorkingDirectory=$AM_DIR)"
  else
    cat > "$UNIT" <<EOF
[Unit]
Description=DSH Memory Autostore Daemon (TencentDB Agent Memory)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$AM_DIR
ExecStart=$NODE_BIN scripts/dsh-memory-autostore.mjs
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
    info "OK  已写 $UNIT"
  fi
  run "systemctl --user daemon-reload || true"
  if [ "$NO_START" = 1 ]; then
    info "SKIP 未 enable/start（--no-start）"
  else
    run "systemctl --user enable --now dsh-memory-autostore.service || true"
    info "已 enable --now dsh-memory-autostore.service"
  fi
fi

# --- engine（第三方引擎单元模板渲染） -------------------------------------------
if has engine; then
  echo "-- engine（第三方 TencentDB Agent Memory，需另行检出）"
  info "ENGINE_DIR=$ENGINE_DIR  MEMORY_HOME=$MEMORY_HOME"
  if [ "$DRY" != 1 ]; then
    mkdir -p "$SYSTEMD_DIR"
    for t in "$PKG_DIR"/templates/systemd/*.service; do
      out="$SYSTEMD_DIR/$(basename "$t")"
      [ -f "$out" ] && { info "SKIP $(basename "$t")（已存在，不覆盖）"; continue; }
      sed -e "s#@ENGINE_DIR@#$ENGINE_DIR#g" -e "s#@MEMORY_HOME@#$MEMORY_HOME#g" -e "s#@NODE_BIN@#$NODE_BIN#g" \
          -e "s#@REPO_ROOT@#$REPO_ROOT#g" "$t" > "$out"
      info "OK  $(basename "$t")"
    done
    info "填好 key 文件后再：systemctl --user enable --now memory-gateway-full memory-knowledge memory-panel memory-proxy tdai-gateway memory-bridge"
  fi
fi

echo "== 完成 =="
echo "  重启 dsh web 后生效（cordis 条目在进程启动时加载）；MCP→native 切换后工具名不再带 mcp__ 前缀。"
