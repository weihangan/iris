param([string]$PackageRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PackageRoot)
$fail = 0; $warn = 0
function Require-Path([string]$relative) {
  if (Test-Path -LiteralPath (Join-Path $root $relative)) { Write-Host "PASS $relative" }
  else { Write-Host "FAIL $relative"; $script:fail++ }
}
function Optional-Path([string]$relative) {
  if (Test-Path -LiteralPath (Join-Path $root $relative)) { Write-Host "PASS $relative" }
  else { Write-Host "WARN $relative (install before voice use)"; $script:warn++ }
}
Write-Host "Auditing $root"
@('package.json','electron','src','chat5-compat/server.js','chat5-compat/tts_engine/selina_tts_api.py','chat5-compat/tts_engine/run_patched.py','models/赛琳娜Q/manifest.json','models/shared/voice-actions.json') | ForEach-Object { Require-Path $_ }
Optional-Path 'runtime/python_gpu/python.exe'; Optional-Path 'runtime/python_cpu/python.exe'; Optional-Path 'runtime/gpt-sovits'
$codeFiles = Get-ChildItem -LiteralPath $root -Recurse -File -Include *.js,*.ts,*.ps1,*.py -ErrorAction SilentlyContinue
$absoluteSource = $codeFiles | Select-String -Pattern '(?i)(D:\\trae|C:\\Users\\[^\\]+\\Desktop)' -SimpleMatch
if ($absoluteSource) { Write-Host 'FAIL hard-coded development path found'; $fail++ } else { Write-Host 'PASS no hard-coded development path in source' }
$secret = $codeFiles | Select-String -Pattern '(?i)(sk-[A-Za-z0-9]{20,}|api[_-]?key\s*[:=]\s*[''\"][^$''\"]+)' -ErrorAction SilentlyContinue
if ($secret) { Write-Host 'FAIL possible secret found'; $fail++ } else { Write-Host 'PASS no obvious secrets' }
Write-Host "Audit result: FAIL=$fail WARN=$warn"
if ($fail -gt 0) { exit 1 }
