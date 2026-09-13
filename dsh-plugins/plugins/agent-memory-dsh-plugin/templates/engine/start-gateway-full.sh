#!/usr/bin/env bash
# 模板：渲染时替换 @ENGINE_DIR@ / @HOME@ / @NODE_BIN@（install.sh --only engine 会替换后写到 systemd 目录）
# LLM key 从 600 权限文件读取，避免 systemd 明文暴露。
# MemoryCore 完整版 gateway 启动脚本
# 从 key 文件读取 LLM key（避免 systemd 明文暴露）
set -e

export TDAI_GATEWAY_CONFIG="@ENGINE_DIR@/MemoryCore/tdai-gateway.full.yaml"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_MODEL="deepseek-flash"
export TDAI_LLM_API_KEY="$(cat @HOME@/.config/memory-gateway/llm_key.txt)"
export TDAI_EMBEDDING_API_KEY="$(cat @HOME@/.config/memory-gateway/embedding_key.txt)"

cd @ENGINE_DIR@/MemoryCore
exec @NODE_BIN@ --dns-result-order=ipv4first --import tsx/esm src/gateway/server.ts
