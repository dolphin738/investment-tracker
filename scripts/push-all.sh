#!/usr/bin/env bash
#
# push-all.sh — 一键把当前分支推送到所有已配置远端 (github + cnb)
#
# 用法:
#   ./push-all.sh                  # 推当前分支到 github + cnb
#   ./push-all.sh main             # 指定分支名
#   CNB_TOKEN=xxx ./push-all.sh    # CNB 走内嵌 token 推送 (CI / 沙箱无凭证时)
#
# 设计要点:
#   - 默认用 clean remote URL 推送 (适合本地已配置 CNB 凭证 / SSH)
#   - 若设了 CNB_TOKEN 环境变量, 对 cnb remote 临时内嵌 token 推送;
#     token 仅存在于本次进程内存, 不写入 git config, 推完不留痕
#   - CNB 用户名可用 CNB_USER 环境变量覆盖 (默认 dolphin738)

set -euo pipefail

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
CNB_USER="${CNB_USER:-dolphin738}"

echo "==> Pushing branch '${BRANCH}' to all remotes..."

for remote in origin cnb; do
  if ! git remote get-url "$remote" >/dev/null 2>&1; then
    echo "  (skip) remote '$remote' not configured"
    continue
  fi

  url="$(git remote get-url "$remote")"

  if [ "$remote" = "cnb" ] && [ -n "${CNB_TOKEN:-}" ]; then
    auth_url="$(printf '%s' "$url" | sed "s#^https://#https://${CNB_USER}:${CNB_TOKEN}@#")"
    echo "==> [$remote] push with embedded token (CNB_TOKEN)"
    git push "$auth_url" "$BRANCH"
  else
    echo "==> [$remote] push"
    git push "$remote" "$BRANCH"
  fi

  echo "==> [$remote] done"
done

echo "==> All remotes pushed."
