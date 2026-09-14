param([ValidateSet('cpu','gpu')][string]$Device = 'cpu')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = if ($env:IRIS_RUNTIME_ROOT) { [IO.Path]::GetFullPath($env:IRIS_RUNTIME_ROOT) } else { Join-Path $root 'runtime' }
$python = Join-Path $runtime ("python_{0}\python.exe" -f $Device)
if (-not (Test-Path -LiteralPath $python)) { throw "Missing $python. Run install-runtime.ps1 first." }
$req = Join-Path $root 'build-resources/python-cpu-asr-requirements.txt'
& $python -m pip install -r $req
if ($LASTEXITCODE -ne 0) { throw 'ASR dependency installation failed' }
& $python -m pip install numpy scipy soundfile
if ($LASTEXITCODE -ne 0) { throw 'ASR audio dependency installation failed' }
Write-Host 'Voice input dependencies installed. Download a FunASR/SenseVoice model and set CHATX2_ASR_MODEL_DIR if needed.'
