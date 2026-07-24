<#
.SYNOPSIS
    Cryptia デプロイパイプライン用の repository secrets / variables を一括登録する。

.DESCRIPTION
    GitHub Actions デプロイパイプライン（.github/workflows/deploy.yml）が参照する
    Cryptia 固有の設定値を GitHub CLI (gh) 経由で登録する。

    - Windows PowerShell 5.1 で実行可能（PowerShell 7 は不要）
    - 本ファイルは UTF-8 (BOM付き) で保存されている（Shift-JIS 環境での文字化け防止）
    - 冪等: 何度実行しても安全（既存の設定値を上書きするのみ）
    - 機密値はコマンドライン引数に載せず一時ファイル経由で標準入力から渡す

    登録内容:
      [repository variables（非機密）]
        SETUP_CMD / UNIT_TEST_CMD / INTEGRATION_TEST_CMD / SCENARIO_TEST_CMD / DEPLOY_CMD
        NUXT_VERTEX_LOCATION / NUXT_VERTEX_MODEL
        NUXT_PUBLIC_FIREBASE_API_KEY / NUXT_PUBLIC_FIREBASE_AUTH_DOMAIN /
        NUXT_PUBLIC_FIREBASE_PROJECT_ID / NUXT_PUBLIC_FIREBASE_APP_ID
        （Firebase Web 設定は公開可能な識別子のため variables で管理）
      [repository secrets（機密）]
        DEPLOY_TOKEN  = サービスアカウント JSON キーの全文
        DEPLOY_TARGET = Firebase プロジェクト ID

    前提条件:
    - GitHub CLI (gh) がインストール済みかつ認証済み（gh auth login）
    - 対象リポジトリへの管理者権限
    - Firebase/GCP サービスアカウント JSON キー（roles/firebase.admin,
      roles/cloudfunctions.developer, roles/iam.serviceAccountUser 相当）

.PARAMETER Repo
    対象リポジトリ（owner/repo 形式）。省略時はカレントリポジトリから自動検出。

.PARAMETER ProjectId
    Firebase / GCP プロジェクト ID（必須）。

.PARAMETER ServiceAccountJsonPath
    サービスアカウント JSON キーファイルのパス（必須）。

.PARAMETER FirebaseApiKey
    Firebase Web API キー（任意。未指定時は Firestore 同期なしのローカルモードで動作）。

.PARAMETER FirebaseAuthDomain
    Firebase Auth ドメイン（任意。例: your-project.firebaseapp.com）。

.PARAMETER FirebaseAppId
    Firebase Web アプリ ID（任意）。

.PARAMETER VertexLocation
    Vertex AI のリージョン（既定: asia-northeast1）。

.PARAMETER VertexModel
    Vertex AI のモデル名（既定: gemini-2.0-flash）。

.EXAMPLE
    .\scripts\setup-cryptia-secrets.ps1 -ProjectId "my-cryptia-prod" -ServiceAccountJsonPath "C:\keys\sa.json"

.EXAMPLE
    .\scripts\setup-cryptia-secrets.ps1 -Repo "owner/cryptia" -ProjectId "my-cryptia-prod" `
        -ServiceAccountJsonPath "C:\keys\sa.json" `
        -FirebaseApiKey "AIza..." -FirebaseAuthDomain "my-cryptia-prod.firebaseapp.com" -FirebaseAppId "1:123:web:abc"
#>
[CmdletBinding()]
param(
    [string]$Repo = "",
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][string]$ServiceAccountJsonPath,
    [string]$FirebaseApiKey = "",
    [string]$FirebaseAuthDomain = "",
    [string]$FirebaseAppId = "",
    [string]$VertexLocation = "asia-northeast1",
    [string]$VertexModel = "gemini-2.0-flash"
)

$ErrorActionPreference = 'Stop'

# 登録失敗を集約する（1件の失敗で全体を止めない: 非ブロッキングエラーハンドリング）
$Failures = New-Object System.Collections.ArrayList

function Test-Prerequisites {
    $ghCmd = Get-Command gh -ErrorAction SilentlyContinue
    if ($null -eq $ghCmd) {
        throw "GitHub CLI (gh) が見つかりません。https://cli.github.com/ からインストールしてください。"
    }
    gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI が未認証です。'gh auth login' を実行してから再試行してください。"
    }
}

function Resolve-TargetRepo {
    param([string]$RepoArg)
    if ($RepoArg -ne "") { return $RepoArg }
    $detected = gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($detected)) {
        throw "リポジトリを自動検出できませんでした。-Repo 'owner/repo' を指定してください。"
    }
    return $detected
}

function Set-RepoVariable {
    param([string]$TargetRepo, [string]$Name, [string]$Value)
    gh variable set $Name --repo $TargetRepo --body $Value
    if ($LASTEXITCODE -ne 0) {
        [void]$script:Failures.Add("variable: $Name")
        Write-Warning "variable '$Name' の登録に失敗しました（処理は継続します）"
    } else {
        Write-Host "  [OK] variable $Name = $Value"
    }
}

function Set-RepoSecretViaFile {
    param([string]$TargetRepo, [string]$Name, [string]$Value)
    # 値をコマンドライン引数・プロセス一覧に露出させないため、
    # 改行を付与しない一時ファイル + 標準入力リダイレクトで渡す
    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tempFile, $Value)
        cmd /c "gh secret set $Name --repo $TargetRepo < `"$tempFile`""
        if ($LASTEXITCODE -ne 0) {
            [void]$script:Failures.Add("secret: $Name")
            Write-Warning "secret '$Name' の登録に失敗しました（処理は継続します）"
        } else {
            Write-Host "  [OK] secret   $Name を登録しました（値は非表示）"
        }
    } finally {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
}

# --- メイン処理 -------------------------------------------------------------

Test-Prerequisites
$TargetRepo = Resolve-TargetRepo -RepoArg $Repo
Write-Host "対象リポジトリ: $TargetRepo"
Write-Host ""

# --- サービスアカウント JSON の読み込みと簡易検証 ---
if (-not (Test-Path $ServiceAccountJsonPath)) {
    throw "サービスアカウント JSON が見つかりません: $ServiceAccountJsonPath"
}
$saJson = [System.IO.File]::ReadAllText($ServiceAccountJsonPath)
if ($saJson -notmatch '"type"\s*:\s*"service_account"') {
    throw "指定されたファイルはサービスアカウント JSON キーではないようです: $ServiceAccountJsonPath"
}

# --- repository variables（非機密: パイプラインコマンド） ---
Write-Host "[repository variables: パイプラインコマンド]"
Set-RepoVariable -TargetRepo $TargetRepo -Name 'SETUP_CMD' -Value 'bash scripts/ci-setup.sh'
Set-RepoVariable -TargetRepo $TargetRepo -Name 'UNIT_TEST_CMD' -Value 'cd app && pnpm run test:unit'
Set-RepoVariable -TargetRepo $TargetRepo -Name 'INTEGRATION_TEST_CMD' -Value 'cd app && pnpm run test:integration'
Set-RepoVariable -TargetRepo $TargetRepo -Name 'SCENARIO_TEST_CMD' -Value 'cd app && pnpm run test:scenario'
Set-RepoVariable -TargetRepo $TargetRepo -Name 'DEPLOY_CMD' -Value 'bash scripts/deploy-firebase.sh'

Write-Host ""
Write-Host "[repository variables: アプリ設定（公開可能な識別子）]"
Set-RepoVariable -TargetRepo $TargetRepo -Name 'NUXT_VERTEX_LOCATION' -Value $VertexLocation
Set-RepoVariable -TargetRepo $TargetRepo -Name 'NUXT_VERTEX_MODEL' -Value $VertexModel
if ($FirebaseApiKey -ne "") {
    Set-RepoVariable -TargetRepo $TargetRepo -Name 'NUXT_PUBLIC_FIREBASE_API_KEY' -Value $FirebaseApiKey
    Set-RepoVariable -TargetRepo $TargetRepo -Name 'NUXT_PUBLIC_FIREBASE_PROJECT_ID' -Value $ProjectId
    if ($FirebaseAuthDomain -ne "") {
        Set-RepoVariable -TargetRepo $TargetRepo -Name 'NUXT_PUBLIC_FIREBASE_AUTH_DOMAIN' -Value $FirebaseAuthDomain
    }
    if ($FirebaseAppId -ne "") {
        Set-RepoVariable -TargetRepo $TargetRepo -Name 'NUXT_PUBLIC_FIREBASE_APP_ID' -Value $FirebaseAppId
    }
} else {
    Write-Host "  [SKIP] Firebase Web 設定は未指定（アプリはローカル保存モードで動作します）"
}

# --- repository secrets（機密） ---
Write-Host ""
Write-Host "[repository secrets（機密）]"
Set-RepoSecretViaFile -TargetRepo $TargetRepo -Name 'DEPLOY_TOKEN' -Value $saJson
Set-RepoSecretViaFile -TargetRepo $TargetRepo -Name 'DEPLOY_TARGET' -Value $ProjectId

# --- 登録結果の確認 ---
Write-Host ""
Write-Host "[登録結果の確認]"
Write-Host "--- repository secrets ---"
gh secret list --repo $TargetRepo
Write-Host "--- repository variables ---"
gh variable list --repo $TargetRepo

Write-Host ""
if ($Failures.Count -gt 0) {
    Write-Host "[WARN] 一部の登録に失敗しました:" -ForegroundColor Yellow
    foreach ($f in $Failures) { Write-Host "  - $f" -ForegroundColor Yellow }
    Write-Host "失敗した項目のみ再実行してください（再実行は安全です）。"
    exit 1
} else {
    Write-Host "[OK] すべての登録が完了しました。" -ForegroundColor Green
    Write-Host "次の手順: GitHub Actions の「デプロイパイプライン」を workflow_dispatch で実行してください。"
    exit 0
}
