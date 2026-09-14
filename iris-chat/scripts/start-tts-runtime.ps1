param([ValidateSet('cpu','gpu')][string]$Device = 'gpu')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtimeRoot = if ($env:IRIS_RUNTIME_ROOT) { [IO.Path]::GetFullPath($env:IRIS_RUNTIME_ROOT) } else { Join-Path $root 'runtime' }
$configPath = Join-Path $runtimeRoot 'runtime-config.json'
if (Test-Path -LiteralPath $configPath) { $data = Get-Content -Raw $configPath | ConvertFrom-Json } else {
  $data = [pscustomobject]@{ device = $Device; ttsPort = 9882 }
}
$pythonName = if ($Device -eq 'gpu') { 'python_gpu' } else { 'python_cpu' }
$pythonCandidates = @(
  (Join-Path $runtimeRoot "$pythonName/python.exe"),
  (Join-Path $root "python_env_$Device/python.exe")
)
$python = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $python) { throw "$Device Python runtime not found. Run scripts/install-runtime.ps1 -Device $Device" }
$gpt = if ($env:GPT_SOVITS_ROOT) { [IO.Path]::GetFullPath($env:GPT_SOVITS_ROOT) } else { Join-Path $runtimeRoot 'gpt-sovits' }
if (-not (Test-Path -LiteralPath $gpt)) {
  $legacy = Join-Path $root 'GPT-SoVITS-lite'
  if (Test-Path -LiteralPath $legacy) { $gpt = $legacy }
}
$ttsScript = Join-Path $root 'chat5-compat/tts_engine/selina_tts_api.py'
$patched = Join-Path $root 'chat5-compat/tts_engine/run_patched.py'
if (-not (Test-Path -LiteralPath $ttsScript)) { throw "TTS API entry not found: $ttsScript" }
$env:APP_ROOT = Join-Path $root 'chat5-compat'
$env:APP_DATA_DIR = if ($env:APP_DATA_DIR) { $env:APP_DATA_DIR } else { Join-Path $root 'userData' }
$env:GPT_SOVITS_ROOT = $gpt
$port = if ($null -ne $data.ttsPort) { $data.ttsPort } else { 9882 }
$env:TTS_PORT = [string]$port
$env:CHATX2_TTS_PORT = $env:TTS_PORT
$env:TTS_DEVICE = if ($Device -eq 'gpu') { 'cuda' } else { 'cpu' }
$env:is_half = if ($Device -eq 'gpu') { 'True' } else { 'False' }
$env:CUDA_VISIBLE_DEVICES = if ($Device -eq 'gpu') { $env:CUDA_VISIBLE_DEVICES } else { '' }
Write-Host "Starting iris-chat TTS on port $($env:TTS_PORT) using $Device"
Push-Location (Split-Path -Parent $ttsScript)
try {
  if (Test-Path -LiteralPath $patched) { & $python $patched $ttsScript } else { & $python $ttsScript }
} finally { Pop-Location }
