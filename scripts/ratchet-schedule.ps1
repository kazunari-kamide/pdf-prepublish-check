# SPDX-License-Identifier: AGPL-3.0-only
#
# Ratchet を定時に回すタスクを、Windows のタスクスケジューラに登録する（手順は docs/ratchet-schedule.md）。
# - 既定では登録しない。登録する中身（時刻・起こすコマンド・作業のフォルダ）を表示するだけ。
# - -Register を付けたときだけ登録する。-Unregister で消す。
# - 時刻・呼び方・費用の上限・読む数は ratchet/schedule.json から読む（このスクリプトには書かない）。
# - API キー（ANTHROPIC_API_KEY）・束の場所（OMAMORI_RATCHET_CORPUS など）は、このスクリプトもタスクも持たない。
#   タスクは「ログオンしているときだけ」動かし、登録した人のユーザーの環境変数を引き継ぐ。キーを置くのは本人。
#
# 使い方（リポジトリのフォルダで）：
#   powershell -ExecutionPolicy Bypass -File scripts/ratchet-schedule.ps1              # 表示だけ
#   powershell -ExecutionPolicy Bypass -File scripts/ratchet-schedule.ps1 -Register    # 登録する
#   powershell -ExecutionPolicy Bypass -File scripts/ratchet-schedule.ps1 -Unregister  # 消す

param(
  [switch]$Register,
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $repo "ratchet/schedule.json"
$config = Get-Content -Raw -Encoding UTF8 $configFile | ConvertFrom-Json
$node = (Get-Command node).Source
$entry = "ratchet/schedule.ts"
$prefix = "OmamoriPDF-Ratchet-"

if ($Unregister) {
  $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "$prefix*" }
  foreach ($t in $tasks) {
    Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false
    Write-Output "消しました：$($t.TaskName)"
  }
  if (-not $tasks) { Write-Output "登録されたタスクはありません" }
  return
}

Write-Output "作業のフォルダ：$repo"
Write-Output "起こすもの：`"$node`" $entry"
Write-Output ("設定：呼び方 {0}／{1}／費用の上限 {2} ドル／読む数 {3}" -f $config.via, $(if ($config.dryRun) { "dry-run" } else { "PR を出す" }), $config.runBudgetUsd, $config.bundle)

# 動くときに要る環境変数があるかだけを見る（値は表示しない）
foreach ($name in @("ANTHROPIC_API_KEY", "OMAMORI_RATCHET_CORPUS", "OMAMORI_RATCHET_STATE")) {
  $set = [Environment]::GetEnvironmentVariable($name, "User")
  Write-Output ("ユーザーの環境変数 {0}：{1}" -f $name, $(if ($set) { "ある" } else { "ない" }))
}

foreach ($time in $config.times) {
  $name = $prefix + ($time -replace ":", "")
  Write-Output "タスク：$name（毎日 $time）"
  if ($Register) {
    $action = New-ScheduledTaskAction -Execute $node -Argument $entry -WorkingDirectory $repo
    $trigger = New-ScheduledTaskTrigger -Daily -At $time
    # ログオンしているときだけ動かす（パスワードを保存しない）。止まらない回は 3 時間で止める
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew -StartWhenAvailable:$false
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Ratchet の 1 回分（ratchet/schedule.json）。マージはしない" | Out-Null
    Write-Output "登録しました：$name"
  }
}

if (-not $Register) { Write-Output "登録はしていません（登録するときは -Register を付ける）" }
