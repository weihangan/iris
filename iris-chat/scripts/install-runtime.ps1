param(
  [ValidateSet('cpu','gpu','both')][string]$Device = 'both',
  [string]$PythonLauncher = 'py',
  [string]$PythonVersion = '3.11',
  [switch]$SkipGptClone,
  [string]$GptSource = 'https://github.com/RVC-Boss/GPT-SoVITS.git'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = if ($env:IRIS_RUNTIME_ROOT) { [IO.Path]::GetFullPath($env:IRIS_RUNTIME_ROOT) } else { Join-Path $root 'runtime' }
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

# Preflight: fail early with actionable messages instead of mid-install.
if (-not (Get-Command $PythonLauncher -ErrorAction SilentlyContinue)) {
  throw "Python launcher '$PythonLauncher' not found. Install Python $PythonVersion from https://www.python.org/downloads/ and keep 'py launcher' checked, or pass -PythonLauncher <path>."
}
& $PythonLauncher "-$PythonVersion" -c "print('ok')" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "Python $PythonVersion is not available through '$PythonLauncher'. Install it via the py launcher installer or pass -PythonVersion <installed>."
}
if (-not $SkipGptClone -and -not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'git not found. Install git (https://git-scm.com/download/win) so GPT-SoVITS can be cloned, or rerun with -SkipGptClone and place the source at runtime/gpt-sovits/api.py yourself.'
}

function New-IrisVenv([string]$name) {
  $dir = Join-Path $runtime $name
  $exe = Join-Path $dir 'python.exe'
  if (-not (Test-Path -LiteralPath $exe)) {
    & $PythonLauncher "-$PythonVersion" -m venv $dir
    if ($LASTEXITCODE -ne 0) { throw "Cannot create $name. Install Python $PythonVersion and ensure the py launcher is available." }
  }
  & $exe -m pip install --upgrade pip wheel
  if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed for $name" }
  return $exe
}

function Install-Common([string]$exe) {
  & $exe -m pip install numpy scipy soundfile regex filelock transformers peft requests
  if ($LASTEXITCODE -ne 0) { throw "Common Python dependency installation failed" }
}

if ($Device -in @('cpu','both')) {
  $cpu = New-IrisVenv 'python_cpu'
  & $cpu -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
  if ($LASTEXITCODE -ne 0) { throw 'CPU Torch installation failed' }
  Install-Common $cpu
}
if ($Device -in @('gpu','both')) {
  $gpu = New-IrisVenv 'python_gpu'
  & $gpu -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126
  if ($LASTEXITCODE -ne 0) { throw 'GPU Torch installation failed. Install an NVIDIA driver first.' }
  Install-Common $gpu
}

$gpt = Join-Path $runtime 'gpt-sovits'
if (-not $SkipGptClone -and -not (Test-Path -LiteralPath $gpt)) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required to download GPT-SoVITS, or use -SkipGptClone and copy it manually.' }
  git clone --depth 1 $GptSource $gpt
  if ($LASTEXITCODE -ne 0) { throw 'GPT-SoVITS download failed' }
}
$config = [ordered]@{ schemaVersion = 1; device = if ($Device -eq 'cpu') { 'cpu' } else { 'gpu' }; ttsPort = 9882 }
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'runtime-config.json') -Encoding utf8
Write-Host "Runtime ready at $runtime"
Write-Host 'Next: download the GPT-SoVITS pretrained base models (GPT_SoVITS/pretrained_models) and voice weights separately; they are intentionally not in Git. See README-部署指南.md section 4.'
