<#
.SYNOPSIS
    将当前分支推送到所有已配置的远端（github + cnb）。
.DESCRIPTION
    - 自动遍历 github / cnb 两个远端，未配置的会跳过。
    - 默认使用 git remote 中配置的干净 URL 推送。
    - 若设置了环境变量 CNB_TOKEN，则对 cnb 远端临时内嵌 token 推送
      （token 仅存在于本次进程，不会写入 git config，推送完不留痕）。
    - 可用环境变量 CNB_USER 覆盖默认用户名（dolphin738）。
.PARAMETER Branch
    要推送的分支名，默认取当前分支。
#>
param(
    [string]$Branch = ""
)

# 确定要推送的分支：参数优先，否则用当前分支
if (-not $Branch) {
    $Branch = git rev-parse --abbrev-ref HEAD
}
if (-not $Branch) {
    Write-Host "无法确定当前分支，请通过 -Branch 参数指定。"
    exit 1
}

Write-Host "正在将分支 '$Branch' 推送到所有远端..."

$configuredRemotes = git remote
foreach ($remote in @("origin", "cnb")) {
    if ($configuredRemotes -notcontains $remote) {
        Write-Host "  (跳过) 远端 '$remote' 未配置"
        continue
    }

    if ($remote -eq "cnb" -and $env:CNB_TOKEN) {
        $user = if ($env:CNB_USER) { $env:CNB_USER } else { "dolphin738" }
        $url = "https://${user}:$($env:CNB_TOKEN)@cnb.cool/${user}/investment-tracker.git"
        Write-Host "==> [$remote] 使用内嵌 token 推送 (CNB_TOKEN)"
        git push -u $url $Branch
    } else {
        Write-Host "==> [$remote] 推送中"
        git push -u $remote $Branch
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [错误] 推送到 '$remote' 失败（exit=$LASTEXITCODE）"
        exit $LASTEXITCODE
    }
    Write-Host "==> [$remote] 完成"
}

Write-Host "所有远端推送完毕。"
exit $LASTEXITCODE
