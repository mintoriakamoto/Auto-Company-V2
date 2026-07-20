param(
    [string]$TaskName = "AutoCompany-WSL-Start"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command schtasks.exe -ErrorAction SilentlyContinue)) {
    throw "schtasks.exe not found."
}

$queryOutput = & schtasks.exe /Query /TN $TaskName /V /FO LIST 2>&1
$code = $LASTEXITCODE

# Match Get-AutostartTaskState in status-win.ps1: exit 0 = configured,
# exit 1 = the task genuinely does not exist, any other code = a transient
# or permission error that must NOT be reported as "not configured".
if ($code -eq 0) {
    foreach ($line in $queryOutput) {
        Write-Host $line
    }
    Write-Host "Autostart: CONFIGURED ($TaskName)"
    exit 0
}
if ($code -eq 1) {
    Write-Host "Autostart: NOT CONFIGURED ($TaskName)"
    exit 0
}

Write-Host "Autostart: UNKNOWN (schtasks exit ${code}) ($TaskName)"
foreach ($line in $queryOutput) {
    Write-Host $line
}
exit 0
