param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$swarmRoot = Split-Path -Parent $PSScriptRoot
$swarmNode = (Get-Command node.exe).Source
& $swarmNode (Join-Path $swarmRoot 'dist\cli.js') 'watchdog' '--config' $Config
exit $LASTEXITCODE
