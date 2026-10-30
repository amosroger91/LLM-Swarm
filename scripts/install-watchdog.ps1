param(
  [Parameter(Mandatory=$true)][string]$Config,
  [string]$TaskName = 'LLM-Swarm-Recovery'
)
$ErrorActionPreference = 'Stop'
$swarmRoot = Split-Path -Parent $PSScriptRoot
$swarmConfig = (Resolve-Path -LiteralPath $Config).Path
$swarmCli = Join-Path $swarmRoot 'dist\cli.js'
if (-not (Test-Path -LiteralPath $swarmCli)) { throw 'Run npm run build first.' }
# No stored password and no elevation. A live scheduler causes a clean no-op.
$swarmRunner = Join-Path $PSScriptRoot 'watchdog-runner.ps1'
$swarmAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -Config "{1}"' -f $swarmRunner,$swarmConfig) -WorkingDirectory $swarmRoot
$swarmTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$swarmSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$swarmPrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $swarmAction -Trigger $swarmTrigger -Settings $swarmSettings -Principal $swarmPrincipal -Description 'Resume interrupted local swarm jobs and supervise worker questions; live schedulers retain ownership.' -Force | Select-Object TaskName,State
