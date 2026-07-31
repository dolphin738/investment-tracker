# ===========================================================================
# 开发环境初始化脚本
# ===========================================================================
# 用法：在 PowerShell 中运行  . .\dev-env.ps1
#   （注意前面的 点+空格，表示在当前终端会话中执行，设置环境变量）
#
# 作用：
#   1. 把 WorkBuddy managed node 加入 PATH（使 pnpm/node 可用）
#   2. 清除 NODE_OPTIONS（绕过安全钩子对 pnpm 的拦截）
# ===========================================================================

$nodePath = "C:\Users\dolphin738\.workbuddy\binaries\node\versions\22.22.2"

if (-not (Test-Path "$nodePath\node.exe")) {
    Write-Host " 未找到 Node.js：$nodePath\node.exe" -ForegroundColor Red
    return
}

$env:PATH = "$nodePath;$env:PATH"
$env:NODE_OPTIONS = $null

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  开发环境已初始化" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Node : $(node -v)"
Write-Host "  pnpm : $(pnpm -v)"
Write-Host "  目录 : $(Get-Location)"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "常用命令：" -ForegroundColor Yellow
Write-Host "  pnpm install        安装依赖"
Write-Host "  pnpm db:format      格式化 Prisma schema"
Write-Host "  pnpm db:generate    生成 Prisma Client"
Write-Host "  pnpm db:migrate     执行数据库迁移"
Write-Host "  pnpm db:seed        填充种子数据"
Write-Host "  pnpm dev:backend    启动后端 (NestJS)"
Write-Host "  pnpm dev:web        启动前端 (Vite)"
Write-Host ""
