param([ValidateSet('cpu','gpu')][string]$Device = 'gpu')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = if ($env:IRIS_RUNTIME_ROOT) { [IO.Path]::GetFullPath($env:IRIS_RUNTIME_ROOT) } else { Join-Path $root 'runtime' }
$pythonName = if ($Device -eq 'gpu') { 'python_gpu' } else { 'python_cpu' }
$python = @((Join-Path $runtime "$pythonName/python.exe"), (Join-Path $root "python_env_$Device/python.exe")) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$gpt = if ($env:GPT_SOVITS_ROOT) { [IO.Path]::GetFullPath($env:GPT_SOVITS_ROOT) } else { Join-Path $runtime 'gpt-sovits' }
if (-not (Test-Path -LiteralPath $gpt)) { $gpt = Join-Path $root 'GPT-SoVITS-lite' }
if (-not (Test-Path -LiteralPath $python)) { throw "Python runtime missing: $python" }
$ttsScript = Join-Path $root 'chat5-compat/tts_engine/selina_tts_api.py'
if (-not (Test-Path -LiteralPath $ttsScript)) { throw "TTS API script missing: $ttsScript" }
if (-not (Test-Path -LiteralPath $gpt)) { Write-Warning "GPT-SoVITS source missing: $gpt (install it before synthesis)" }
& $python -c "import sys,importlib,json; names=['torch','transformers.utils','regex','filelock','scipy','soundfile']; out={'python':sys.executable,'modules':{},'errors':{}};
for n in names:
 try: importlib.import_module(n); out['modules'][n]=True
 except Exception as e: out['modules'][n]=False; out['errors'][n]=str(e)
try:
 import torch; out.update({'torch':torch.__version__,'cuda_available':bool(torch.cuda.is_available())})
except Exception as e: out['torch_error']=str(e)
print(json.dumps(out,ensure_ascii=False))"
if ($LASTEXITCODE -ne 0) { throw "Python/Torch check failed" }
if ($Device -eq 'gpu') {
  & $python -c "import torch; raise SystemExit(0 if torch.cuda.is_available() else 2)"
  if ($LASTEXITCODE -ne 0) { throw 'GPU runtime selected but CUDA is unavailable. Install a compatible NVIDIA driver/Torch build.' }
}
Write-Host "TTS runtime check passed: $Device"
