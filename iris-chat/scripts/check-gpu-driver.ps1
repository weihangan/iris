$ErrorActionPreference = 'Stop'
Write-Host '=== iris-chat GPU runtime check ==='
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA|GeForce|RTX|GTX|Quadro|Tesla' }
if (-not $gpu) {
  Write-Warning 'NVIDIA GPU not detected.'
  Start-Process 'https://www.nvidia.com/Download/index.aspx'
  exit 2
}
$gpu | Select-Object Name, DriverVersion, DriverDate | Format-Table -AutoSize
try {
  $smi = Get-Command nvidia-smi -ErrorAction Stop
  & $smi.Source --query-gpu=name,driver_version,memory.total --format=csv,noheader
} catch {
  Write-Warning 'nvidia-smi not found. Install the NVIDIA driver and reopen PowerShell.'
  Start-Process 'https://www.nvidia.com/Download/index.aspx'
  exit 3
}
$python = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime/python_gpu/python.exe'
if (Test-Path -LiteralPath $python) {
  & $python -c "import torch; print('torch='+torch.__version__); print('torch_cuda='+str(torch.version.cuda)); print('cuda_available='+str(torch.cuda.is_available()))"
}
Write-Host 'Check complete. Driver must be compatible with the bundled GPU Python/Torch runtime.'
