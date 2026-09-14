param([ValidateSet('cpu','gpu')][string]$Device = 'gpu')
$root = Split-Path -Parent $PSScriptRoot
$runtime = if ($env:IRIS_RUNTIME_ROOT) { [IO.Path]::GetFullPath($env:IRIS_RUNTIME_ROOT) } else { Join-Path $root 'runtime' }
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$config = Join-Path $runtime 'runtime-config.json'
$data = if (Test-Path -LiteralPath $config) { Get-Content -Raw $config | ConvertFrom-Json } else { [pscustomobject]@{ device='gpu'; ttsPort=9882 } }
$data.device = $Device
$data | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $config -Encoding utf8
Write-Host "Selected TTS device: $Device ($config)"
Write-Host "Selected TTS device: $Device"
