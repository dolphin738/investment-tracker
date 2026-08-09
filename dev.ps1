# ===========================================================================
# 一键开发脚本 (investment_return_tracker)
# ===========================================================================
# 用法（PowerShell 中 cd 到项目根目录后，任选其一）：
#
#   # 方式一：dot-source（推荐交互使用，函数留在当前会话）
#   . .\dev.ps1              # 初始化环境 + 自动安装依赖（幂等，已装则跳过）
#   . .\dev.ps1 -SkipInstall # 仅设置环境，跳过依赖安装（秒进环境）
#   . .\dev.ps1 -Force       # 强制重装后端 + 前端依赖
#   Start-Dev / Stop-Dev                 # 启停前后端（独立窗口）
#   Start-Backend / Stop-Backend         # 仅启动/停止后端
#   Start-Frontend / Stop-Frontend       # 仅启动/停止前端
#
#   # 方式二：直接调用（无需先 dot-source，适合一次性启停）
#   .\dev.ps1               # 无参数 → 初始化 + 弹出数字菜单（输入编号即执行）
#   .\dev.ps1 start          # 等价于「初始化 + Start-Dev」
#   .\dev.ps1 stop           # 直接 Stop-Dev（跳过初始化）
#   .\dev.ps1 start -Force   # 强制重装依赖后启动
#   .\dev.ps1 restart                 # 重启前后端（跳过依赖安装）
#   .\dev.ps1 restart backend         # 仅重启后端（前端不受影响）
#   .\dev.ps1 restart frontend        # 仅重启前端
#   .\dev.ps1 stop backend / frontend  # 仅停止指定服务
#
#   菜单编号（无参数运行 .\dev.ps1 时出现）：
#     [1]启动前后端  [2]启动后端  [3]启动前端
#     [4]停止前后端  [5]停止后端  [6]停止前端
#     [7]重启前后端  [8]重启后端  [9]重启前端
#     [i]重装依赖   [0]退出
#
# 提供能力：
#   1) 轻量环境设置（被 dot-source 或直接启动/重启时自动执行）：
#        - 把 WorkBuddy managed Python 与 Node 加入 PATH
#        - 清除 NODE_OPTIONS（绕过安全钩子对 pnpm / npm 的拦截）
#        - 由 uv 管理 backend/.venv（uv sync 自动创建，替代旧的 pip venv）
#        - 复制 backend/.env.example -> backend/.env（若不存在）
#   2) Init-Dev —— 重型依赖安装（幂等，可被 -SkipInstall / -Force 控制）
#   3) Start-Dev / Start-Backend / Start-Frontend —— 启动（各开独立窗口）
#   4) Stop-Dev / Stop-Backend / Stop-Frontend —— 关闭（按服务标签 PID 文件）
#   5) restart —— 先停后起（支持单服务），默认跳过依赖安装（-Force 可强制重装）
#
# 设计参考：上级目录 app/dev-env.ps1（仅做 PATH + NODE_OPTIONS 的轻量设置）。
# 本脚本不修改、不依赖 dev-env.ps1，仅借鉴其"按需、轻量"的理念。
# ===========================================================================

#requires -Version 5.1
param(
    [switch]$SkipInstall,   # 跳过 pip / pnpm / npm 依赖安装（仅设置环境）
    [switch]$Force,         # 强制重装依赖（忽略已安装标记）
    [string]$Action = "",   # 直接调用时使用：start / stop / restart（空 = 仅初始化，供 dot-source）
    [string]$Service = ""   # 服务定向：backend / frontend（空 = 前后端都作用）
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
# 每个服务独立的 PID 文件（带标签，避免 stop/restart 误杀另一个服务）
$backendPidFile  = Join-Path $root ".dev-backend.pid"
$frontendPidFile = Join-Path $root ".dev-frontend.pid"

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

# $pyDir 必须在任何 Start-* 之前定义：后端子进程命令的 here-string 会把 $pyDir
# 展开进 $env:PATH，未定义则子进程找不到 uvicorn。与 Action 无关，故无条件计算。
$pyDir = Split-Path -Parent $python

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
# 通用：启动 / 停止单个服务的 helper（各开独立 PowerShell 窗口）
# ===========================================================================

# 启动一个服务：把子进程命令写入临时 .ps1，再用 powershell -File 拉独立窗口，
# PID 写入指定的 pid 文件（带服务标签）。返回进程对象。
function Start-Service {
    param(
        [string]$Name,     # backend / frontend（用于临时文件名）
        [string]$Script,   # 子进程要执行的命令（here-string）
        [string]$PidFile,  # 该服务的 PID 文件
        [string]$Label     # 中文名，用于打印
    )
    $tmpDir = if ($env:TEMP) { $env:TEMP } else { $env:TMPDIR }
    $scriptFile = Join-Path $tmpDir "dev-$Name-$(Get-Random).ps1"
    [System.IO.File]::WriteAllText($scriptFile, $Script, (New-Object System.Text.UTF8Encoding $true))

    $proc = Start-Process powershell -ArgumentList "-NoExit", "-File", $scriptFile -PassThru
    if ($proc) {
        $proc.Id | Out-File -FilePath $PidFile -Encoding utf8
        Write-Host "→ $Label 已启动（PID=$($proc.Id)）" -ForegroundColor Green
    } else {
        Write-Host "  $Label 启动失败。" -ForegroundColor Red
    }
    return $proc
}

# 停止一个服务：按 pid 文件杀进程树，并删除 pid 文件。
function Stop-Service {
    param(
        [string]$PidFile,
        [string]$Label
    )
    if (-not (Test-Path $PidFile)) {
        Write-Host "  $Label 未在运行（未找到 $PidFile）。" -ForegroundColor Yellow
        return
    }
    Write-Host "→ 停止 $Label ..." -ForegroundColor Cyan
    Get-Content $PidFile | ForEach-Object {
        $pidv = $_.Trim()
        if ($pidv -match '^\d+$') {
            & taskkill /PID $pidv /T /F 2>$null
            Write-Host "  → 已请求关闭进程树 PID=$pidv" -ForegroundColor Gray
        }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "→ $Label 已停止。" -ForegroundColor Green
}

# ===========================================================================
# 函数：Start-Backend / Start-Frontend / Start-Dev
# ===========================================================================

function Start-Backend {
    # ---- 后端启动命令（here-string）----
    # 说明：
    #   - 子进程需要自行展开的 $env:PATH / $env:NODE_OPTIONS 用反引号 ` 转义，
    #     避免被“主脚本”提前展开；
    #   - $pyDir / $nodePath / $backend / $BackendPort 是主脚本变量，
    #     在构造 here-string 时由主作用域展开为字面量（路径 / 端口号）。
    $backendCmd = @"
`$ErrorActionPreference = 'Stop'
`$env:NODE_OPTIONS = `$null
`$env:PATH = "$pyDir;$pyDir\Scripts;$nodePath;`$env:PATH"
Set-Location "$backend"
Write-Host "→ 启动后端：uvicorn app.main:app --reload --port $BackendPort" -ForegroundColor Cyan
uv run uvicorn app.main:app --reload --port $BackendPort
"@
    $proc = Start-Service -Name "backend" -Script $backendCmd -PidFile $backendPidFile -Label "后端"
    if ($proc) {
        Write-Host "  后端 Swagger : http://localhost:$BackendPort/api/docs" -ForegroundColor Yellow
    }
    return $proc
}

function Start-Frontend {
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
    $proc = Start-Service -Name "frontend" -Script $frontendCmd -PidFile $frontendPidFile -Label "前端"
    if ($proc) {
        Write-Host "  前端页面     : http://localhost:$FrontendPort" -ForegroundColor Yellow
    }
    return $proc
}

function Start-Dev {
    Write-Host "→ 启动开发服务（前后端并发，各开独立窗口）" -ForegroundColor Cyan
    $b = Start-Backend
    $f = Start-Frontend
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  开发服务已启动" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  后端 Swagger : http://localhost:$BackendPort/api/docs" -ForegroundColor Yellow
    Write-Host "  前端页面     : http://localhost:$FrontendPort" -ForegroundColor Yellow
    Write-Host "  API 代理     : 前端 /api 已通过 Vite 代理转发到 http://localhost:$BackendPort" -ForegroundColor DarkGray
    Write-Host "  后端 PID     : $(if ($b) { $b.Id } else { 'N/A' })"
    Write-Host "  前端 PID     : $(if ($f) { $f.Id } else { 'N/A' })"
    Write-Host "  停止命令     : Stop-Dev（或 .\dev.ps1 stop）" -ForegroundColor Yellow
    Write-Host "  单服务重启   : .\dev.ps1 restart backend / restart frontend" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Cyan
}

# ===========================================================================
# 函数：Stop-Backend / Stop-Frontend / Stop-Dev
# ===========================================================================

function Stop-Backend  { Stop-Service -PidFile $backendPidFile  -Label "后端" }
function Stop-Frontend { Stop-Service -PidFile $frontendPidFile -Label "前端" }
function Stop-Dev {
    Stop-Backend
    Stop-Frontend
    # 兼容清理旧版单文件 PID（升级前遗留）；删除失败不阻断停止流程
    $legacy = Join-Path $root ".dev-pids.txt"
    if (Test-Path $legacy) { Remove-Item $legacy -Force -ErrorAction SilentlyContinue }
}

# ===========================================================================
# 3. 环境初始化（轻量 + 重型；stop 跳过以加速，restart 仅做轻量以提速）
# ===========================================================================

# 轻量环境设置（stop 不需要，故抽成函数；start / dot-source / restart 按需调用）
function Set-LightEnv {
    # 前置 managed Python 目录及其 Scripts（uv 安装于此），确保 uv / pip 可用
    $env:PATH = "$pyDir;$pyDir\Scripts;$env:PATH"
    if (Test-Path "$nodePath\node.exe") {
        $env:PATH = "$nodePath;$env:PATH"
    }
    $env:NODE_OPTIONS = $null   # 绕过安全钩子对 pnpm / npm 的拦截
}

if ($Action -eq "stop") {
    # 仅停止，不做任何环境设置（最快）
} elseif ($Action -eq "restart") {
    # 重启：仅做轻量环境设置（PATH/NODE_OPTIONS，供子进程 here-string 使用），
    # 默认跳过 Init-Dev（依赖应已就绪，提速）；-Force 时可强制重装。
    Set-LightEnv
    if ($Force) {
        Init-Dev -Force:$true
    }
} else {
    # start 或直接 dot-source：完整初始化
    Set-LightEnv

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
    Write-Host "  .\dev.ps1 stop           # 直接停止（前后端）"
    Write-Host "  .\dev.ps1 restart        # 重启前后端（跳过依赖安装）"
    Write-Host "  .\dev.ps1 restart backend   # 仅重启后端"
    Write-Host "  .\dev.ps1 restart frontend  # 仅重启前端"
    Write-Host "  .\dev.ps1 stop backend      # 仅停止后端"
    Write-Host "  .\dev.ps1 stop frontend     # 仅停止前端"
    Write-Host "  Init-Dev / Start-Dev / Stop-Dev            # 手动（重新）安装 / 启停"
    Write-Host "  Start-Backend / Stop-Backend               # 仅后端"
    Write-Host "  Start-Frontend / Stop-Frontend             # 仅前端"
    Write-Host "  Show-DevMenu                               # 调出数字菜单（dot-source 后可用）"
    Write-Host ""
}

# ===========================================================================
# 4. 交互式菜单（无参数直接运行 .\dev.ps1 时触发；dot-source 不触发）
# ===========================================================================
# 判断是否 dot-source：dot-source 时 $MyInvocation.InvocationName 为 '.'，
# 直接运行时为脚本路径。dot-source 的语义是「把函数注入当前会话」，弹菜单会
# 阻塞会话，故不触发；用户可在 dot-source 后手动输入 Show-DevMenu 调出菜单。
function Show-DevMenu {
    # 非交互环境（输入被重定向 / 自动化 / NonInteractive 主机）下跳过菜单，
    # 避免 Read-Host 卡死。直接 return，函数已定义，不影响后续手动调用。
    try {
        if ([Console]::IsInputRedirected) { return }
    } catch { return }

    while ($true) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "  开发菜单" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "  [1] 启动前后端          [4] 停止前后端          [7] 重启前后端" -ForegroundColor White
        Write-Host "  [2] 仅启动后端          [5] 仅停止后端          [8] 仅重启后端" -ForegroundColor White
        Write-Host "  [3] 仅启动前端          [6] 仅停止前端          [9] 仅重启前端" -ForegroundColor White
        Write-Host "  [i] 重新安装依赖 (Init-Dev)" -ForegroundColor Yellow
        Write-Host "  [0] 退出菜单" -ForegroundColor DarkGray
        Write-Host "========================================" -ForegroundColor Cyan
        try {
            $choice = (Read-Host "请输入编号").Trim().ToLower()
        } catch {
            # 主机非交互（如 -NonInteractive），无法读取输入，退出菜单
            Write-Host "→ 当前主机非交互，已退出菜单。" -ForegroundColor DarkGray
            return
        }
        switch ($choice) {
            "1" { Start-Dev }
            "2" { Start-Backend }
            "3" { Start-Frontend }
            "4" { Stop-Dev }
            "5" { Stop-Backend }
            "6" { Stop-Frontend }
            "7" { Stop-Dev; Start-Dev }
            "8" { Stop-Backend; Start-Backend }
            "9" { Stop-Frontend; Start-Frontend }
            "i" { Init-Dev }
            "0" { Write-Host "→ 已退出菜单。" -ForegroundColor DarkGray; return }
            ""  { return }   # 直接回车也退出
            default { Write-Host "  无效输入：$choice（请输入 0-9 或 i）" -ForegroundColor Red }
        }
    }
}

# ===========================================================================
# 5. 动作分发（dot-source 时空 Action 仅定义函数不触发动作）
# ===========================================================================
$isDotSourced = ($MyInvocation.InvocationName -eq '.')

if ($Action -eq "" -and -not $isDotSourced) {
    # 无参数直接运行 → 弹交互菜单（初始化已在上面第 3 段完成）
    Show-DevMenu
} else {
    switch ($Action) {
        "start" {
            if ($Service -eq "backend")      { Start-Backend }
            elseif ($Service -eq "frontend") { Start-Frontend }
            else                             { Start-Dev }
        }
        "stop" {
            if ($Service -eq "backend")      { Stop-Backend }
            elseif ($Service -eq "frontend") { Stop-Frontend }
            else                             { Stop-Dev }
        }
        "restart" {
            if ($Service -eq "backend")      { Stop-Backend;  Start-Backend }
            elseif ($Service -eq "frontend") { Stop-Frontend; Start-Frontend }
            else                             { Stop-Dev; Start-Dev }
        }
    }
}
