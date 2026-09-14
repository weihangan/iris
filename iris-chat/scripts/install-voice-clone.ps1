param([ValidateSet('cpu','gpu')][string]$Device = 'gpu')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = if ($env:IRIS_RUNTIME_ROOT) { [IO.Path]::GetFullPath($env:IRIS_RUNTIME_ROOT) } else { Join-Path $root 'runtime' }
$python = Join-Path $runtime ("python_{0}\python.exe" -f $Device)
$gpt = if ($env:GPT_SOVITS_ROOT) { [IO.Path]::GetFullPath($env:GPT_SOVITS_ROOT) } else { Join-Path $runtime 'gpt-sovits' }
if (-not (Test-Path -LiteralPath $python)) { throw "Missing $python. Run install-runtime.ps1 first." }
if (-not (Test-Path -LiteralPath $gpt)) { throw "Missing GPT-SoVITS at $gpt. Run install-runtime.ps1 or copy it there." }
& $python -m pip install funasr openai-whisper ffmpeg-python omegaconf hydra-core
if ($LASTEXITCODE -ne 0) { throw 'Voice clone dependency installation failed' }
$requirements = Join-Path $root 'build-resources/python-gpu-clone-requirements.txt'
if (Test-Path -LiteralPath $requirements) {
  & $python -m pip install -r $requirements
  if ($LASTEXITCODE -ne 0) { throw 'Clone requirements installation failed' }
}
Write-Host 'Voice clone environment installed.'
Write-Host 'Place pretrained GPT/SoVITS, HuBERT, BERT and UVR models under GPT-SoVITS as required by its version.'
