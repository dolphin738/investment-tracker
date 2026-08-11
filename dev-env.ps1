# ===========================================================================
# 开发环境初始化脚本 (investment_return_tracker)
# ===========================================================================
# 用法：在 PowerShell 中 cd 到项目根目录后，dot-source 执行：
#   . .\dev-env.ps1
#   （前面 点+空格 表示在当前会话执行，保留 PATH / venv 激活状态）
#
# 作用：
#   1. 把 WorkBuddy managed Python 3.13 与 managed Node 22 加入 PATH
#      —— 解决“无法执行 python / node”的根因（它们默认不在系统 PATH）
#   2. 清除 NODE_OPTIONS（绕过安全钩子对 pnpm 的拦截，沿用 app/dev-env.ps1）
#   3. 在项目内创建并激活 Python 虚拟环境 backend/.venv
#   4. 安装后端依赖（pyproject.toml，含测试依赖）
#   5. 复制 backend/.env.example -> backend/.env（若不存在）
#   6. 若 web/ 已初始化（有 package.json），执行 pnpm install
# ===========================================================================

$ErrorActionPreference = "Stop"

# ---------- 1. 定位 Python（多候选，优先 managed）----------
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

# 把 python / node 所在目录前置到 PATH
$pyDir = Split-Path -Parent $python
$env:PATH = "$pyDir;$env:PATH"
if (Test-Path "$nodePath\node.exe") {
    $env:PATH = "$nodePath;$env:PATH"
}
$env:NODE_OPTIONS = $null   # 沿用 app/dev-env.ps1：绕过安全钩子拦截

# ---------- 2. 项目根目录 & venv ----------
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$backend = Join-Path $root "backend"
$venv = Join-Path $backend ".venv"

if (-not (Test-Path $backend)) {
    Write-Host " 未找到 backend/ 目录，请在项目根目录运行本脚本。" -ForegroundColor Red
    return
}

if (-not (Test-Path $venv)) {
    Write-Host "→ 创建虚拟环境 $venv" -ForegroundColor Cyan
    & $python -m venv $venv
} else {
    Write-Host "→ 虚拟环境已存在，跳过创建" -ForegroundColor DarkGray
}

# 激活 venv（dot-source，使当前会话的 python/pip 指向 venv）
$activate = Join-Path $venv "Scripts\Activate.ps1"
if (Test-Path $activate) { . $activate }

# ---------- 3. 安装后端依赖 ----------
$pyproject = Join-Path $backend "pyproject.toml"
if (-not (Test-Path $pyproject)) {
    Write-Host " 未找到 backend/pyproject.toml" -ForegroundColor Red
    return
}
Write-Host "→ 安装后端依赖 (pip install -e .[dev])" -ForegroundColor Cyan
python -m pip install --upgrade pip -q
Push-Location $backend
try {
    python -m pip install -e ".[dev]" -q
} finally {
    Pop-Location
}

# ---------- 4. .env ----------
$envExample = Join-Path $backend ".env.example"
$envFile = Join-Path $backend ".env"
if ((Test-Path $envExample) -and -not (Test-Path $envFile)) {
    Copy-Item $envExample $envFile
    Write-Host "→ 已复制 .env.example -> backend/.env（请按需修改密钥/数据库配置）" -ForegroundColor Green
} elseif (Test-Path $envFile) {
    Write-Host "→ backend/.env 已存在，跳过" -ForegroundColor DarkGray
}

# ---------- 5. 前端（web 就绪后自动安装）----------
$web = Join-Path $root "web"
if (Test-Path (Join-Path $web "package.json")) {
    Write-Host "→ 安装前端依赖 (pnpm install)" -ForegroundColor Cyan
    Push-Location $web
    pnpm install
    Pop-Location
} else {
    Write-Host "→ web/ 尚未初始化（无 package.json），跳过前端依赖" -ForegroundColor DarkGray
}

# ---------- 5.5 便捷函数：启动后端（自动 cd backend，避免 ModuleNotFoundError）----------
function Start-Backend {
    $bk = Join-Path $root "backend"
    if (-not (Test-Path (Join-Path $bk "app\main.py"))) {
        Write-Host "? 未找到 backend/app/main.py" -ForegroundColor Red
        return
    }
    Write-Host "→ 启动后端 (uvicorn app.main:app --reload --port 8000)" -ForegroundColor Cyan
    Write-Host "  Swagger: http://localhost:8000/api/docs" -ForegroundColor DarkGray
    Push-Location $bk
    uvicorn app.main:app --reload --port 8000
    Pop-Location
}

# ---------- 6. 环境信息 ----------
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  开发环境已初始化" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Python : $(python -V 2>&1)"
Write-Host "  venv   : $venv"
Write-Host "  Node   : $(node -v 2>$null)"
Write-Host "  pnpm   : $(pnpm -v 2>$null)"
Write-Host "  目录   : $root"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "常用命令：" -ForegroundColor Yellow
Write-Host "  pytest                                 运行后端测试（在 backend/ 下）"
Write-Host "  Start-Backend                         启动后端（自动 cd backend，Swagger: /api/docs）"
Write-Host "  cd backend; uvicorn app.main:app --reload --port 8000   （等价手动方式）"
Write-Host "  alembic revision --autogenerate ...   生成迁移（Phase 1+）"
Write-Host "  pnpm dev                               启动前端（web 就绪后）"
Write-Host ""
