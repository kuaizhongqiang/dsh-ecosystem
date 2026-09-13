#!/usr/bin/env bash
# agent-memory-dsh-plugin —— Linux/macOS 安装器（dsh-ecosystem）
#
# 把「TencentDB Agent Memory」在 DSH 侧的接入装到 web profile：
#   memory     主记忆 MCP 通道（mcp-agent-memory → mcp-bridge，npx 或本地构建）
#   codegraph  代码图谱只读通道（mcp-agent-memory-codegraph，本地 MCP server）
#   autostore  自动入库守护（turn/end → MemoryCore，systemd user 单元）
#   engine     第三方引擎的 systemd 单元模板渲染（需另有引擎检出，见 README）
#
# 用法：
#   ./install.sh                                  # 默认 memory,codegraph,autostore
#   ./install.sh --only memory,codegraph          # 子集安装
#   ./install.sh --only engine --engine-dir /path # 渲染引擎单元模板
#   ./install.sh --uninstall [--only ...]         # 卸载（引擎单元模板仅提示，不删）
#   ./install.sh --no-start                       # 只装不 enable/start
#   ./install.sh --dry-run                        # 只打印将执行的动作
#
# 幂等：载荷覆盖复制；cordis.patch.yml 按标记块增删，重复执行不产生重复条目。
# 凭证：本脚本不写任何密钥；身份三元组/团队 key 由你在 cordis.patch.yml 的 env 里填
#       （见 .env.example），引擎 LLM key 放 600 权限文件由引擎启动脚本读取。
set -euo pipefail

ONLY="memory,codegraph,autostore"
UNINSTALL=0
NO_START=0
DRY=0
PROFILE_DIR="${PROFILE_DIR:-}"
REPO_ROOT="${REPO_ROOT:-}"
ENGINE_DIR="${ENGINE_DIR:-$HOME/projects/TencentDB-Agent-Memory}"
MEMORY_HOME="${MEMORY_HOME:-$HOME/.openclaw/memory-tdai}"

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 ;;
    --only=*) ONLY="${1#*=}"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --profile-dir) PROFILE_DIR="${2:-}"; shift 2 ;;
    --repo-root) REPO_ROOT="${2:-}"; shift 2 ;;
    --engine-dir) ENGINE_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "ERROR: 未知参数 $1（--help 查看用法）" >&2; exit 1 ;;
  esac
done

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -z "$REPO_ROOT" ] && REPO_ROOT="$(cd "$PKG_DIR/../../.." && pwd)"
AM_DIR="$REPO_ROOT/agent-memory"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
[ -z "$PROFILE_DIR" ] && PROFILE_DIR="$DSH_HOME/profiles/web"
PATCH="$PROFILE_DIR/cordis.patch.yml"
PLUGINS_DIR="$PROFILE_DIR/plugins"
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
echo "  包目录 : $PKG_DIR"
echo "  伞仓根 : $REPO_ROOT"
echo "  profile: $PROFILE_DIR"
echo "  services: $ONLY$([ "$UNINSTALL" = 1 ] && echo '  (uninstall)')"

# --- cordis.patch.yml 标记块增删 ---------------------------------------------
patch_has() { [ -f "$PATCH" ] && grep -q "id: $1$" "$PATCH"; }

patch_add() { # $1=id
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

patch_del() { # $1=id —— 删除标记块（含标记行）
  local id="$1"
  patch_has "$id" || { info "SKIP patch $id (不存在)"; return 0; }
  if [ "$DRY" = 1 ]; then echo "  [dry-run] 移除 cordis 条目 $id"; return 0; fi
  awk -v id="$id" -v MARK="$MARK" '
    $0 ~ ("^# >>> " MARK ": " id " >>>$") { skip=1; next }
    $0 ~ ("^# <<< " MARK ": " id " <<<$") { skip=0; next }
    skip != 1 { print }
  ' "$PATCH" > "$PATCH.tmp" && mv "$PATCH.tmp" "$PATCH"
  info "OK  patch 条目已移除: $id"
}

# --- 1. codegraph ------------------------------------------------------------
if has codegraph; then
  echo "-- codegraph"
  if [ "$UNINSTALL" = 1 ]; then
    patch_del mcp-agent-memory-codegraph
    if [ -d "$PLUGINS_DIR/agent-memory-codegraph" ]; then
      run "mv '$PLUGINS_DIR/agent-memory-codegraph' '$PLUGINS_DIR/agent-memory-codegraph.removed-\$(date +%Y%m%d-%H%M%S)'"
    fi
  else
    run "mkdir -p '$PLUGINS_DIR'"
    run "rm -rf '$PLUGINS_DIR/agent-memory-codegraph'"
    run "cp -R '$PKG_DIR/plugins/agent-memory-codegraph' '$PLUGINS_DIR/agent-memory-codegraph'"
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
fi

# --- 2. memory（主记忆 MCP 通道） --------------------------------------------
if has memory; then
  echo "-- memory"
  if [ "$UNINSTALL" = 1 ]; then
    patch_del mcp-agent-memory
  else
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
          TASK_ID: '<项目标签 task_id>'
        toolCallTimeoutMs: 30000
EOF
)"
    info "记得把 env 里的 <...> 占位符换成真实值（取值方式见 .env.example / README）"
    [ -d "$AM_DIR/packages/mcp-bridge/dist" ] && info "检测到本地构建 $AM_DIR/packages/mcp-bridge/dist —— 可把 args 改为 ['$AM_DIR/packages/mcp-bridge/dist/index.js'] 以脱离 npm"
  fi
fi

# --- 3. autostore（自动入库守护） --------------------------------------------
if has autostore; then
  echo "-- autostore"
  UNIT="$SYSTEMD_DIR/dsh-memory-autostore.service"
  if [ "$UNINSTALL" = 1 ]; then
    if [ -f "$UNIT" ]; then
      run "systemctl --user disable --now dsh-memory-autostore.service || true"
      run "rm -f '$UNIT'"
      run "systemctl --user daemon-reload || true"
      info "已移除 autostore 单元（state 文件保留：\$DSH_HOME/.dsh-memory-autostore-state.json）"
    fi
  else
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
      info "SKIP 未 enable/start（--no-start）；手动：systemctl --user enable --now dsh-memory-autostore"
    else
      run "systemctl --user enable --now dsh-memory-autostore.service || true"
      info "已 enable --now dsh-memory-autostore.service"
    fi
  fi
fi

# --- 4. engine（第三方引擎单元模板渲染） -------------------------------------
if has engine; then
  echo "-- engine（第三方 TencentDB Agent Memory，需另行检出）"
  if [ "$UNINSTALL" = 1 ]; then
    info "引擎单元模板不由本脚本删除；如由本脚本渲染，请手动删 ~/.config/systemd/user/memory-*.service"
  else
    info "ENGINE_DIR=$ENGINE_DIR"
    info "MEMORY_HOME=$MEMORY_HOME（运行时数据目录）"
    info "按 templates/systemd/*.service 渲染到 $SYSTEMD_DIR（占位符替换为绝对路径）"
    if [ "$DRY" != 1 ]; then
      mkdir -p "$SYSTEMD_DIR"
      for t in "$PKG_DIR"/templates/systemd/*.service; do
        out="$SYSTEMD_DIR/$(basename "$t")"
        [ -f "$out" ] && { info "SKIP $(basename "$t")（已存在，不覆盖）"; continue; }
        sed -e "s#@ENGINE_DIR@#$ENGINE_DIR#g" -e "s#@MEMORY_HOME@#$MEMORY_HOME#g" -e "s#@NODE_BIN@#$NODE_BIN#g" \
            -e "s#@REPO_ROOT@#$REPO_ROOT#g" "$t" > "$out"
        info "OK  $(basename "$t")"
      done
      info "按 README 的「引擎前置」填好 key 文件后再：systemctl --user enable --now memory-gateway-full memory-knowledge memory-panel memory-proxy tdai-gateway memory-bridge"
    fi
  fi
fi

echo "== 完成 =="
[ "$UNINSTALL" = 0 ] && echo "  重启 dsh web 后生效：cordis 条目为进程启动时加载；MCP 通道可用性见 README 的「验收」。"
