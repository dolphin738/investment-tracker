# ===========================================================================
# 一键开发脚本 (investment_return_tracker)
# ===========================================================================
# 用法（PowerShell 中 cd 到项目根目录后，任选其一）：
#
#   # 方式一：dot-source（推荐交互使用，函数留在当前会话）
#   . .\dev.ps1              # 初始化环境 + 自动安装依赖（幂等，已装则跳过）
#   . .\dev.ps1 -SkipInstall # 仅设置环境，跳过依赖安装（秒进环境）
#   . .\dev.ps1 -Force       # 强制重装后端 + 前端依赖
#   Start-Dev                # 一条命令并发启动前后端（独立窗口）
#   Stop-Dev                 # 关闭所有开发进程
#
#   # 方式二：直接调用（无需先 dot-source，适合一次性启停）
#   .\dev.ps1 start          # 等价于「初始化 + Start-Dev」
#   .\dev.ps1 stop           # 直接 Stop-Dev（跳过初始化）
#   .\dev.ps1 start -Force   # 强制重装依赖后启动
#
# 提供能力：
#   1) 轻量环境设置（被 dot-source 或直接启动时自动执行）：
#        - 把 WorkBuddy managed Python 与 Node 加入 PATH
#        - 清除 NODE_OPTIONS（绕过安全钩子对 pnpm / npm 的拦截）
#        - 由 uv 管理 backend/.venv（uv sync 自动创建，替代旧的 pip venv）
#        - 复制 backend/.env.example -> backend/.env（若不存在）
#   2) Init-Dev —— 重型依赖安装（幂等，可被 -SkipInstall / -Force 控制）
#   3) Start-Dev —— 一条命令并发启动前后端（各开独立窗口）
#   4) Stop-Dev  —— 关闭所有开发进程
#
# 设计参考：上级目录 app/dev-env.ps1（仅做 PATH + NODE_OPTIONS 的轻量设置）。
# 本脚本不修改、不依赖 dev-env.ps1，仅借鉴其"按需、轻量"的理念。
# ===========================================================================

#requires -Version 5.1
param(
    [switch]$SkipInstall,   # 跳过 pip / pnpm / npm 依赖安装（仅设置环境）
    [switch]$Force,         # 强制重装依赖（忽略已安装标记）
    [string]$Action = ""    # 直接调用时使用：start / stop（空 = 仅初始化，供 dot-source）
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# 可配置变量：后端监听端口
# ---------------------------------------------------------------------------
# 默认 3000，因为 web/vite.config.ts 的 dev server 把 /api 代理到
# http://localhost:3000（见 web/vite.config.ts 的 server.proxy 配置）。
# 如果你执意想让后端跑在 8000：
#   (a) 把这里的 $BackendPort 改成 8000；
#   (b) 同时必须把 web/vite.config.ts 里 proxy.target 改成
#       'http://localhost:8000'，否则浏览器里的 /api 请求会连到 3000 上
#       根本没有进程监听，导致 502。
# 两者必须保持一致！
$BackendPort = 3000

# 前端 dev server 端口（来自 web/vite.config.ts 的 server.port）
$FrontendPort = 5173

# ---------------------------------------------------------------------------
# 0. 项目根目录推导（避免硬编码，除 managed 运行时路径外）
# ---------------------------------------------------------------------------
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$backend    = Join-Path $root "backend"
$web        = Join-Path $root "web"
$venv       = Join-Path $backend ".venv"
$pyproject  = Join-Path $backend "pyproject.toml"
$envExample = Join-Path $backend ".env.example"
$envFile    = Join-Path $backend ".env"
$devPidsFile = Join-Path $root ".dev-pids.txt"

# ---------------------------------------------------------------------------
# 健壮性：必要的目录 / 文件检查
# ---------------------------------------------------------------------------
if (-not (Test-Path $backend)) {
    Write-Host " 未找到 backend/ 目录，请在项目根目录运行本脚本。" -ForegroundColor Red
    return
}
if (-not (Test-Path $pyproject)) {
    Write-Host " 未找到 backend/pyproject.toml，无法安装后端依赖。" -ForegroundColor Red
    return
}

# ---------------------------------------------------------------------------
# 1. 定位 Python（多候选，优先 managed）
# ---------------------------------------------------------------------------
function Find-Python {
    $candidates = @(
        "C:\Users\dolphin738\.workbuddy\binaries\python\versions\3.13.12\python.exe",
        "C:\Users\dolphin738\.workbuddy\binaries\python\versions\3.14.3\python.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    foreach ($cmd in @("py", "python3", "python")) {
        try {
            $p = (Get-Command $cmd -ErrorAction Stop).Source
            $ver = & $p -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
            if ($ver -and ([version]$ver -ge [version]"3.11")) { return $p }
        } catch { }
    }
    return $null
}

$nodePath = "C:\Users\dolphin738\.workbuddy\binaries\node\versions\22.22.2"

$python = Find-Python
if (-not $python) {
    Write-Host " 未找到 Python (>=3.11)。请安装 Python 或确认 WorkBuddy managed Python 路径。" -ForegroundColor Red
    return
}

# ---------------------------------------------------------------------------
# 2. 依赖安装函数 Init-Dev（基于 uv，幂等，可被 -SkipInstall / -Force 控制）
# ---------------------------------------------------------------------------
function Ensure-Uv {
    # uv 安装在 managed Python 的 Scripts 目录下（已在 PATH 前置范围），
    # 若缺失则自动安装到 managed Python。
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        return $true
    }
    Write-Host "→ 未检测到 uv，尝试安装到 managed Python..." -ForegroundColor Cyan
    & $python -m pip install -q uv
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        Write-Host "→ uv 已安装：$(uv --version)" -ForegroundColor Green
        return $true
    }
    Write-Host "  uv 安装失败，请手动安装 uv（https://docs.astral.sh/uv/）后重试。" -ForegroundColor Red
    return $false
}

function Init-Dev {
    [CmdletBinding()]
    param([switch]$Force)

    # ---- 后端依赖（统一由 uv 管理）----
    # 依赖真相源：backend/pyproject.toml（[project].dependencies + [dev] extra）。
    # `uv sync --extra dev` 自动创建并管理 backend/.venv，安装主依赖 + dev
    # 依赖（pytest / httpx2 等），并生成/更新 uv.lock。uv 自身幂等
    # （pyproject 与 uv.lock 未变则快速跳过）。
    if (-not (Ensure-Uv)) { return }

    # 若 .venv 存在但非 uv 管理（旧 pip venv 残留），删除交由 uv 重建
    if (Test-Path $venv) {
        $cfg = Join-Path $venv "pyvenv.cfg"
        $isUvManaged = (Test-Path $cfg) -and ((Get-Content $cfg -Raw) -match "uv\s*=")
        if (-not $isUvManaged) {
            Write-Host "→ 发现旧的 pip 虚拟环境，删除并改用 uv 管理" -ForegroundColor Yellow
            Remove-Item $venv -Recurse -Force
        }
    }

    Write-Host "→ 同步后端依赖 (uv sync --extra dev)" -ForegroundColor Cyan
    Push-Location $backend
    try {
        if ($Force) {
            & uv sync --extra dev --reinstall
        } else {
            & uv sync --extra dev
        }
    } finally {
        Pop-Location
    }
    Write-Host "→ 后端依赖同步完成" -ForegroundColor Green



    # ---- 前端依赖（node_modules 已存在则跳过）----
    $pkg = Join-Path $web "package.json"
    if (Test-Path $pkg) {
        $nodeModules = Join-Path $web "node_modules"
        if ((-not $Force) -and (Test-Path $nodeModules)) {
            Write-Host "→ 前端 node_modules 已存在，跳过 pnpm / npm install" -ForegroundColor DarkGray
        } else {
            Write-Host "→ 安装前端依赖" -ForegroundColor Cyan
            Push-Location $web
            try {
                if (Get-Command pnpm -ErrorAction SilentlyContinue) {
                    pnpm install
                } else {
                    Write-Host "  未检测到 pnpm 命令，回退到 npm install。" -ForegroundColor Yellow
                    npm install
                }
            } finally {
                Pop-Location
            }
        }
    } else {
        Write-Host "→ web/ 尚未初始化（无 package.json），跳过前端依赖" -ForegroundColor DarkGray
    }
}

# ===========================================================================
# 函数：Start-Dev —— 并发启动前后端（各开一个独立 PowerShell 窗口）
# ===========================================================================
function Start-Dev {
    Write-Host "→ 启动开发服务（前后端并发，各开独立窗口）" -ForegroundColor Cyan

    # ---- 后端启动命令（here-string）----
    # 说明：
    #   - 子进程需要自行展开的 $env:PATH / $env:NODE_OPTIONS 用反引号 ` 转义，
    #     避免被“主脚本”提前展开；
    #   - $pyDir / $nodePath / $backend / $activate / $BackendPort 是主脚本变量，
    #     在构造 here-string 时由主作用域展开为字面量（路径 / 端口号）。
    $backendCmd = @"
`$ErrorActionPreference = 'Stop'
`$env:NODE_OPTIONS = `$null
`$env:PATH = "$pyDir;$pyDir\Scripts;$nodePath;`$env:PATH"
Set-Location "$backend"
Write-Host "→ 启动后端：uvicorn app.main:app --reload --port $BackendPort" -ForegroundColor Cyan
uv run uvicorn app.main:app --reload --port $BackendPort
"@

    # ---- 前端启动命令（here-string）----
    # 前端窗口无需 venv，但需把 managed Node 目录加入 PATH 并清除 NODE_OPTIONS。
    # 优先 pnpm dev，若 pnpm 不可用则回退 npm run dev。
    $frontendStart = "pnpm dev"
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        $frontendStart = "npm run dev"
    }
    $frontendCmd = @"
`$ErrorActionPreference = 'Stop'
`$env:NODE_OPTIONS = `$null
`$env:PATH = "$nodePath;`$env:PATH"
Set-Location "$web"
Write-Host "→ 启动前端：$frontendStart (port $FrontendPort)" -ForegroundColor Cyan
$frontendStart
"@

    # ---- 各开一个独立 PowerShell 窗口（互不干扰、可独立关闭）----
    # 把子进程要执行的命令写入临时 .ps1 文件，再用 `powershell -File` 启动，
    # 彻底避免 -Command 把含空格路径 / 中文 / 特殊字符经多层引号传递时
    # 被误解析（例如 >>> 被当成重定向运算符）。
    $tmpDir = if ($env:TEMP) { $env:TEMP } else { $env:TMPDIR }
    $backendScript  = Join-Path $tmpDir "dev-backend-$(Get-Random).ps1"
    $frontendScript = Join-Path $tmpDir "dev-frontend-$(Get-Random).ps1"
    [System.IO.File]::WriteAllText($backendScript,  $backendCmd,  (New-Object System.Text.UTF8Encoding $true))
    [System.IO.File]::WriteAllText($frontendScript, $frontendCmd, (New-Object System.Text.UTF8Encoding $true))

    $backendProc  = Start-Process powershell -ArgumentList "-NoExit", "-File", $backendScript  -PassThru
    $frontendProc = Start-Process powershell -ArgumentList "-NoExit", "-File", $frontendScript -PassThru

    # ---- 保存 PID 供 Stop-Dev 使用 ----
    @(
        if ($backendProc)  { $backendProc.Id }
        if ($frontendProc) { $frontendProc.Id }
    ) | Where-Object { $_ } | ForEach-Object { $_ } | Out-File -FilePath $devPidsFile -Encoding utf8

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  开发服务已启动" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  后端 Swagger : http://localhost:$BackendPort/api/docs" -ForegroundColor Yellow
    Write-Host "  前端页面     : http://localhost:$FrontendPort" -ForegroundColor Yellow
    Write-Host "  API 代理     : 前端 /api 已通过 Vite 代理转发到 http://localhost:$BackendPort" -ForegroundColor DarkGray
    Write-Host "  后端 PID     : $(if ($backendProc) { $backendProc.Id } else { 'N/A' })"
    Write-Host "  前端 PID     : $(if ($frontendProc) { $frontendProc.Id } else { 'N/A' })"
    Write-Host "  停止命令     : Stop-Dev（或 .\dev.ps1 stop）" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Cyan
}

# ===========================================================================
# 函数：Stop-Dev —— 关闭所有开发进程
# ===========================================================================
function Stop-Dev {
    if (-not (Test-Path $devPidsFile)) {
        Write-Host "没有运行中的开发服务（未找到 $devPidsFile）。" -ForegroundColor Yellow
        return
    }
    Write-Host "→ 停止开发服务..." -ForegroundColor Cyan
    Get-Content $devPidsFile | ForEach-Object {
        $pidv = $_.Trim()
        if ($pidv -match '^\d+$') {
            & taskkill /PID $pidv /T /F 2>$null
            Write-Host "  → 已请求关闭进程树 PID=$pidv" -ForegroundColor Gray
        }
    }
    Remove-Item $devPidsFile -Force
    Write-Host "→ 开发服务已停止。" -ForegroundColor Green
}

# ===========================================================================
# 3. 环境初始化（轻量 + 重型，stop 动作时跳过以加速）
# ===========================================================================
if ($Action -ne "stop") {

    # ---- 轻量环境设置（必跑）----
    $pyDir = Split-Path -Parent $python
    # 前置 managed Python 目录及其 Scripts（uv 安装于此），确保 uv / pip 可用
    $env:PATH = "$pyDir;$pyDir\Scripts;$env:PATH"
    if (Test-Path "$nodePath\node.exe") {
        $env:PATH = "$nodePath;$env:PATH"
    }
    $env:NODE_OPTIONS = $null   # 绕过安全钩子对 pnpm / npm 的拦截

    # ---- backend/.venv 由 uv 管理（Init-Dev 中的 uv sync 自动创建，无需手动 venv）----

    # ---- backend/.env（不存在则从 .env.example 复制）----
    if ((Test-Path $envExample) -and -not (Test-Path $envFile)) {
        Copy-Item $envExample $envFile
        Write-Host "→ 已复制 .env.example -> backend/.env（请按需修改密钥/数据库配置）" -ForegroundColor Green
    } elseif (Test-Path $envFile) {
        Write-Host "→ backend/.env 已存在，跳过" -ForegroundColor DarkGray
    }

    # ---- 重型依赖安装（幂等）----
    if ($SkipInstall) {
        Write-Host "→ 已跳过依赖安装（-SkipInstall）" -ForegroundColor DarkGray
    } else {
        Init-Dev -Force:$Force
    }

    # ---- 环境信息 ----
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  开发环境已初始化" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Python     : $(python -V 2>&1)"
    Write-Host "  venv       : $venv"
    Write-Host "  Node       : $(node -v 2>$null)"
    Write-Host "  pnpm       : $(if (Get-Command pnpm -ErrorAction SilentlyContinue) { pnpm -v 2>$null } else { '不可用（将回退 npm）' })"
    Write-Host "  npm        : $(npm -v 2>$null)"
    Write-Host "  BackendPort: $BackendPort"
    Write-Host "  FrontendPort: $FrontendPort"
    Write-Host "  目录       : $root"
    Write-Host "========================================" -ForegroundColor Cyan

    # ---- 常用命令帮助 ----
    Write-Host ""
    Write-Host "常用命令：" -ForegroundColor Yellow
    Write-Host "  . .\dev.ps1              # 初始化环境并安装依赖（已装则跳过）"
    Write-Host "  . .\dev.ps1 -SkipInstall # 仅设置环境，跳过依赖安装"
    Write-Host "  . .\dev.ps1 -Force       # 强制重装依赖"
    Write-Host "  .\dev.ps1 start          # 直接一键启动（无需先 dot-source）"
    Write-Host "  .\dev.ps1 stop           # 直接停止"
    Write-Host "  Init-Dev                 # 手动（重新）安装依赖"
    Write-Host "  Start-Dev                # 一键并发启动前后端（独立窗口）"
    Write-Host "  Stop-Dev                 # 停止前后端（基于 .dev-pids.txt）"
    Write-Host ""
}

# ===========================================================================
# 4. 直接调用时的动作分发（dot-source 时空 Action 不触发，仅定义函数）
# ===========================================================================
switch ($Action) {
    "start" { Start-Dev }
    "stop"  { Stop-Dev }
}
