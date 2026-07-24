<#
.SYNOPSIS
    デプロイパイプライン用の repository secrets / variables を登録する。

.DESCRIPTION
    GitHub Actions デプロイパイプライン（.github/workflows/deploy.yml）が参照する
    設定値を GitHub CLI (gh) 経由で登録する。

    - 機密値（トークン・接続情報）  → repository secrets
    - 非機密値（テスト・デプロイコマンド）→ repository variables

    冪等: 何度実行しても安全（既存の設定値を上書きするのみ。他のデータには触れない）。
    機密値は画面に表示されず、コマンド履歴にも残らない（対話入力またはファイル入力）。

    前提条件:
    - PowerShell 7.1 以降（Windows PowerShell 5.1 は非対応。https://aka.ms/powershell から入手）
    - GitHub CLI (gh) がインストール済みかつ認証済み（gh auth login）
    - 対象リポジトリへの管理者権限

.PARAMETER Repo
    対象リポジトリ（owner/repo 形式）。省略時はカレントディレクトリの
    リポジトリから自動検出する。

.PARAMETER EnvFile
    KEY=VALUE 形式の設定ファイルパス（例: deploy-secrets.env）。
    指定した場合、対話入力の代わりにファイルから一括登録する。
    UNIT_TEST_CMD / INTEGRATION_TEST_CMD / SCENARIO_TEST_CMD / DEPLOY_CMD /
    SETUP_CMD は variables として、それ以外のキーはすべて secrets として登録する。
    ※ このファイルは .gitignore 済み。登録後は削除を推奨。

.PARAMETER UnitTestCmd
    単体テストの実行コマンド（repository variable: UNIT_TEST_CMD）

.PARAMETER IntegrationTestCmd
    結合テストの実行コマンド（repository variable: INTEGRATION_TEST_CMD）

.PARAMETER ScenarioTestCmd
    シナリオテストの実行コマンド（repository variable: SCENARIO_TEST_CMD）

.PARAMETER DeployCmd
    デプロイの実行コマンド（repository variable: DEPLOY_CMD）

.PARAMETER SetupCmd
    依存関係のインストール等のセットアップコマンド（任意。repository variable: SETUP_CMD）

.EXAMPLE
    # 対話モード（機密値は非表示入力）
    ./scripts/setup-deploy-secrets.ps1 -UnitTestCmd "npm run test:unit" `
        -IntegrationTestCmd "npm run test:integration" `
        -ScenarioTestCmd "npm run test:e2e" `
        -DeployCmd "npm run deploy" `
        -SetupCmd "npm ci"

.EXAMPLE
    # ファイル一括モード
    ./scripts/setup-deploy-secrets.ps1 -EnvFile ./deploy-secrets.env
#>
#Requires -Version 7.1
[CmdletBinding()]
param(
    [string]$Repo,
    [string]$EnvFile,
    [string]$UnitTestCmd,
    [string]$IntegrationTestCmd,
    [string]$ScenarioTestCmd,
    [string]$DeployCmd,
    [string]$SetupCmd
)

$ErrorActionPreference = 'Stop'

# variables（非機密）として扱うキー。それ以外は secrets（機密）として登録する。
$VariableKeys = @('UNIT_TEST_CMD', 'INTEGRATION_TEST_CMD', 'SCENARIO_TEST_CMD', 'DEPLOY_CMD', 'SETUP_CMD')

# 登録失敗を集約する（1件の失敗で全体を止めない: 非ブロッキングエラーハンドリング）
$Failures = [System.Collections.Generic.List[string]]::new()

function Test-Prerequisites {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Error "GitHub CLI (gh) が見つかりません。https://cli.github.com/ からインストールしてください。"
    }
    gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "GitHub CLI が未認証です。'gh auth login' を実行してから再試行してください。"
    }
}

function Resolve-Repo {
    param([string]$Repo)
    if ($Repo) { return $Repo }
    $detected = gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $detected) {
        Write-Error "リポジトリを自動検出できませんでした。-Repo 'owner/repo' を指定してください。"
    }
    return $detected
}

function Set-RepoSecret {
    param([string]$TargetRepo, [string]$Name, [string]$Value)
    # 値は標準入力経由で渡す（コマンドライン引数に載せない = プロセス一覧・履歴に残さない）
    $Value | gh secret set $Name --repo $TargetRepo
    if ($LASTEXITCODE -ne 0) {
        $script:Failures.Add("secret: $Name")
        Write-Warning "secret '$Name' の登録に失敗しました（処理は継続します）"
    } else {
        Write-Host "  ✅ secret   $Name を登録しました（値は非表示）"
    }
}

function Set-RepoVariable {
    param([string]$TargetRepo, [string]$Name, [string]$Value)
    $Value | gh variable set $Name --repo $TargetRepo
    if ($LASTEXITCODE -ne 0) {
        $script:Failures.Add("variable: $Name")
        Write-Warning "variable '$Name' の登録に失敗しました（処理は継続します）"
    } else {
        Write-Host "  ✅ variable $Name = $Value"
    }
}

function Read-SecretValue {
    param([string]$Prompt)
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

# --- メイン処理 -------------------------------------------------------------

Test-Prerequisites
$TargetRepo = Resolve-Repo -Repo $Repo
Write-Host "対象リポジトリ: $TargetRepo"
Write-Host ""

if ($EnvFile) {
    # ===== ファイル一括モード =====
    if (-not (Test-Path $EnvFile)) {
        Write-Error "指定されたファイルが見つかりません: $EnvFile"
    }
    Write-Host "[$EnvFile から一括登録]"
    foreach ($line in Get-Content $EnvFile) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $sep = $trimmed.IndexOf('=')
        if ($sep -lt 1) {
            Write-Warning "KEY=VALUE 形式でない行をスキップしました: $trimmed"
            continue
        }
        $key = $trimmed.Substring(0, $sep).Trim()
        $value = $trimmed.Substring($sep + 1).Trim()
        if ($VariableKeys -contains $key) {
            Set-RepoVariable -TargetRepo $TargetRepo -Name $key -Value $value
        } else {
            Set-RepoSecret -TargetRepo $TargetRepo -Name $key -Value $value
        }
    }
} else {
    # ===== 対話モード =====
    Write-Host "[repository variables（非機密: テスト・デプロイコマンド）]"
    $variableInputs = [ordered]@{
        'UNIT_TEST_CMD'        = $UnitTestCmd
        'INTEGRATION_TEST_CMD' = $IntegrationTestCmd
        'SCENARIO_TEST_CMD'    = $ScenarioTestCmd
        'DEPLOY_CMD'           = $DeployCmd
        'SETUP_CMD'            = $SetupCmd
    }
    foreach ($entry in $variableInputs.GetEnumerator()) {
        $value = $entry.Value
        if (-not $value) {
            $optional = if ($entry.Key -eq 'SETUP_CMD') { '（任意。空欄でスキップ）' } else { '' }
            $value = Read-Host -Prompt "$($entry.Key) $optional"
        }
        if ($value) {
            Set-RepoVariable -TargetRepo $TargetRepo -Name $entry.Key -Value $value
        } elseif ($entry.Key -ne 'SETUP_CMD') {
            $Failures.Add("variable: $($entry.Key)（未入力）")
            Write-Warning "$($entry.Key) が未入力です。デプロイパイプラインの事前検証で失敗します。"
        }
    }

    Write-Host ""
    Write-Host "[repository secrets（機密: 入力値は表示されません）]"
    $tokenValue = Read-SecretValue -Prompt "DEPLOY_TOKEN（デプロイ先の認証トークン）"
    if ($tokenValue) {
        Set-RepoSecret -TargetRepo $TargetRepo -Name 'DEPLOY_TOKEN' -Value $tokenValue
    } else {
        $Failures.Add("secret: DEPLOY_TOKEN（未入力）")
        Write-Warning "DEPLOY_TOKEN が未入力です。デプロイパイプラインの事前検証で失敗します。"
    }
    $targetValue = Read-SecretValue -Prompt "DEPLOY_TARGET（デプロイ先URL・ホスト等。任意。空欄でスキップ）"
    if ($targetValue) {
        Set-RepoSecret -TargetRepo $TargetRepo -Name 'DEPLOY_TARGET' -Value $targetValue
    }
}

# --- 登録結果の検証 ---------------------------------------------------------

Write-Host ""
Write-Host "[登録結果の確認]"
Write-Host "--- repository secrets ---"
gh secret list --repo $TargetRepo
Write-Host "--- repository variables ---"
gh variable list --repo $TargetRepo

Write-Host ""
if ($Failures.Count -gt 0) {
    Write-Host "⚠️ 一部の登録に失敗しました:" -ForegroundColor Yellow
    $Failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    Write-Host "失敗した項目を再実行してください（再実行は安全です）。"
    exit 1
} else {
    Write-Host "✅ すべての登録が完了しました。" -ForegroundColor Green
    if ($EnvFile) {
        Write-Host "セキュリティのため、$EnvFile の削除を推奨します: Remove-Item $EnvFile"
    }
    exit 0
}
