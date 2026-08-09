<#
.SYNOPSIS
    Push local branches to the cnb remote.

.DESCRIPTION
    Resolves the cnb.cool credential and pushes with it embedded in the URL,
    so it works without an interactive git-credential-manager prompt.

    Credential resolution order:
      1. Windows Credential Manager entry "git:https://cnb.cool"
         (read via Win32 CredRead + DPAPI). Works on the user's own machine.
         NOTE: in some non-interactive sandboxes DPAPI decryption is blocked,
         so this may return nothing there.
      2. Environment variable $env:CNB_TOKEN (username from $env:CNB_USER,
         default "dolphin738"). Use this to push from a sandbox / CI where no
         credential store is available: set the PAT first, e.g.
         $env:CNB_TOKEN = "xxxx"; .\push-all.ps1
         (matches the convention in scripts/push-all.sh)
      3. Plain `git push <remote>` so GCM / the normal flow can take over.

    Branches pushed (default): every local branch that has an upstream on the
    given remote (e.g. cnb/main). If none are tracked, it pushes `main`.
    Use -Branch to force a single branch.

.PARAMETER Remote
    Remote name. Default: cnb.

.PARAMETER Branch
    If set, push only this local branch (to the same-named remote branch).
#>
param(
    [string]$Remote = "cnb",
    [string]$Branch = ""
)

$ErrorActionPreference = "Stop"

# ---- locate repo root ----
$repo = (git rev-parse --show-toplevel).Trim()
if (-not $repo) { throw "Not inside a git repository." }
Set-Location $repo
Write-Host "Repo: $repo"

# ---- Win32 credential reader (bypass GCM) ----
$winCredCode = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr pcred);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr pcred);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CryptUnprotectData(
        ref DATA_BLOB pDataIn, IntPtr ppszDataDescr, IntPtr pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, uint dwFlags, ref DATA_BLOB pDataOut);

    [StructLayout(LayoutKind.Sequential)]
    public struct DATA_BLOB {
        public int cbData;
        public IntPtr pbData;
    }

    public static string ReadBlob(IntPtr blobPtr, uint size) {
        if (blobPtr == IntPtr.Zero || size == 0) return "";
        byte[] buf = new byte[size];
        Marshal.Copy(blobPtr, buf, 0, (int)size);
        DATA_BLOB inBlob = new DATA_BLOB { cbData = buf.Length, pbData = Marshal.AllocHGlobal(buf.Length) };
        Marshal.Copy(buf, 0, inBlob.pbData, buf.Length);
        DATA_BLOB outBlob = new DATA_BLOB();
        bool ok = CryptUnprotectData(ref inBlob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref outBlob);
        Marshal.FreeHGlobal(inBlob.pbData);
        if (!ok) return "(decrypt-failed)";
        byte[] outBuf = new byte[outBlob.cbData];
        Marshal.Copy(outBlob.pbData, outBuf, 0, outBlob.cbData);
        return Encoding.UTF8.GetString(outBuf);
    }
}
'@
Add-Type -TypeDefinition $winCredCode -ErrorAction SilentlyContinue

function Get-CnbCredential {
    $ptr = [IntPtr]::Zero
    $candidates = @("git:https://cnb.cool", "git:https://cnb.cool/", "cnb.cool")
    foreach ($t in $candidates) {
        if ([WinCred]::CredRead($t, 1, 0, [ref]$ptr)) {
            $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][WinCred+CREDENTIAL])
            $user = $cred.UserName
            $pass = [WinCred]::ReadBlob($cred.CredentialBlob, $cred.CredentialBlobSize)
            [WinCred]::CredFree($ptr)
            if ($pass -and $pass -ne "(decrypt-failed)") {
                return @{ User = $user; Pass = $pass }
            }
        }
    }
    return $null
}

# ---- resolve remote URL + credential ----
$remoteUrl = (git config --get "remote.$Remote.url").Trim()
if (-not $remoteUrl) { throw "Remote '$Remote' not found." }

$cred = $null
if (-not $cred) { $cred = Get-CnbCredential }
if (-not $cred -and $env:CNB_TOKEN) {
    $cred = @{ User = $(if ($env:CNB_USER) { $env:CNB_USER } else { "dolphin738" }); Pass = $env:CNB_TOKEN }
}

if ($cred) {
    Write-Host "Using cnb.cool credential (user=$($cred.User))."
    $uri = [System.Uri]$remoteUrl
    $authUrl = "{0}://{1}:{2}@{3}{4}" -f $uri.Scheme,
        [System.Uri]::EscapeDataString($cred.User),
        [System.Uri]::EscapeDataString($cred.Pass),
        $uri.Host, $uri.PathAndQuery
} else {
    Write-Host "No cnb.cool credential available; falling back to plain push (GCM will prompt)."
    $authUrl = $remoteUrl
}

# ---- decide which branches to push ----
if ($Branch) {
    $branches = @($Branch)
} else {
    $branches = @()
    $lines = git for-each-ref --format='%(refname:short) %(upstream:short)' refs/heads
    foreach ($l in $lines) {
        if ($l -match '^(.+?)\s+(.+)$') {
            $lb = $Matches[1].Trim(); $up = $Matches[2].Trim()
            if ($up -like "$Remote/*") { $branches += $lb }
        }
    }
    if (-not $branches) { $branches = @("main") }
}

Write-Host ("Branches to push: " + ($branches -join ", "))

# ---- push ----
$overall = 0
foreach ($b in $branches) {
    $rb = $b
    if ($b -like "$Remote/*") { $rb = $b.Substring($Remote.Length + 1) }
    Write-Host ">> git push $Remote  $b -> $rb"
    git push $authUrl "${b}:${rb}" 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "!! push failed for $b (exit $LASTEXITCODE)"
        $overall = $LASTEXITCODE
    }
}
if ($overall -eq 0) { Write-Host "OK: push completed." }
exit $overall
