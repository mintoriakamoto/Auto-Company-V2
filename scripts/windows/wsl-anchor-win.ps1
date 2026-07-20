param(
    [ValidateSet("start", "stop", "status", "run")]
    [string]$Action = "status",
    [string]$Distro = "Ubuntu",
    [string]$RepoWsl = ""
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "wsl.exe not found. Enable WSL first."
}

$repoWin = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path
$pidFile = Join-Path $repoWin ".auto-loop-wsl-anchor.pid"
$stopFile = Join-Path $repoWin ".auto-loop-wsl-anchor.stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Resolve-RepoWslPath {
    param([string]$RawRepoWsl)

    if ($RawRepoWsl) {
        return $RawRepoWsl
    }

    $repoWinForWsl = $repoWin -replace "\\", "/"
    $repoWslRaw = & wsl.exe wslpath -a "$repoWinForWsl"
    if (-not $repoWslRaw) {
        throw "Failed to convert repository path to WSL path."
    }
    $repoWsl = $repoWslRaw.Trim()
    if (-not $repoWsl) {
        throw "Failed to convert repository path to WSL path."
    }
    return $repoWsl
}

function Get-RunningAnchorProcess {
    if (-not (Test-Path $pidFile)) {
        return $null
    }

    $pidText = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    if (-not $pidText) {
        return $null
    }

    $pidValue = 0
    if (-not [int]::TryParse($pidText, [ref]$pidValue)) {
        return $null
    }

    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $proc) {
        return $null
    }

    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue).CommandLine
    if ($cmd -and $cmd -match "wsl-anchor-win\.ps1" -and $cmd -match "-Action\s+run") {
        return $proc
    }
    return $null
}

function Clear-StateFiles {
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Remove-Item $stopFile -ErrorAction SilentlyContinue
}

switch ($Action) {
    "start" {
        $existing = Get-RunningAnchorProcess
        if ($existing) {
            Write-Output "WSL anchor: RUNNING (PID $($existing.Id))"
            exit 0
        }

        $resolvedRepoWsl = Resolve-RepoWslPath -RawRepoWsl $RepoWsl
        Remove-Item $stopFile -ErrorAction SilentlyContinue
        $selfPath = $PSCommandPath

        $proc = Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -PassThru -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $selfPath,
            "-Action", "run",
            "-Distro", $Distro,
            "-RepoWsl", $resolvedRepoWsl
        )

        for ($i = 0; $i -lt 25; $i++) {
            Start-Sleep -Milliseconds 200
            $running = Get-RunningAnchorProcess
            if ($running) {
                Write-Output "WSL anchor started (PID $($running.Id))."
                exit 0
            }
        }

        if ($proc -and -not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Error "Failed to start WSL anchor."
        exit 1
    }

    "run" {
        $resolvedRepoWsl = Resolve-RepoWslPath -RawRepoWsl $RepoWsl
        [System.IO.File]::WriteAllText($pidFile, "$PID`n", $utf8NoBom)
        Remove-Item $stopFile -ErrorAction SilentlyContinue

        $logDir = Join-Path $repoWin "logs"
        $null = New-Item -ItemType Directory -Force -Path $logDir -ErrorAction SilentlyContinue
        $logFile = Join-Path $logDir "wsl-anchor.log"
        function Write-AnchorLog {
            param([string]$Message)
            $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            Add-Content -Path $logFile -Value "[$ts] $Message" -ErrorAction SilentlyContinue
        }

        $failCount = 0
        $maxFails = 5
        $child = $null
        try {
            while (-not (Test-Path $stopFile)) {
                # Launch the keepalive as a TRACKED child so we can terminate
                # it on stop. The previous inline `& wsl.exe ...` blocked here
                # and was orphaned when the parent was force-killed, leaking a
                # wsl.exe (and in-distro sleep) on every stop.
                $child = Start-Process -FilePath "wsl.exe" -WindowStyle Hidden -PassThru -ArgumentList @(
                    "-d", $Distro,
                    "--cd", $resolvedRepoWsl,
                    "bash", "-lc", "while true; do sleep 3600; done"
                )
                $startedAt = Get-Date

                # Supervise: poll for a stop request or the child exiting.
                while (-not $child.HasExited) {
                    if (Test-Path $stopFile) {
                        Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
                        break
                    }
                    Start-Sleep -Seconds 1
                }
                if (Test-Path $stopFile) {
                    break
                }

                # Child exited on its own. A fast exit means WSL/distro is
                # misconfigured — back off and cap retries instead of spinning
                # silently forever.
                $aliveSeconds = ((Get-Date) - $startedAt).TotalSeconds
                if ($aliveSeconds -lt 10) {
                    $failCount++
                    Write-AnchorLog "wsl anchor child exited after $([int]$aliveSeconds)s (fail $failCount/$maxFails, Distro='$Distro')"
                    if ($failCount -ge $maxFails) {
                        Write-AnchorLog "wsl anchor giving up after $maxFails rapid failures; check that WSL distro '$Distro' is available."
                        exit 1
                    }
                    $backoff = [int][Math]::Min(30, [Math]::Pow(2, $failCount))
                    Start-Sleep -Seconds $backoff
                } else {
                    $failCount = 0
                }
            }
        }
        finally {
            if ($child -and -not $child.HasExited) {
                Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
            }
            Clear-StateFiles
        }
        exit 0
    }

    "stop" {
        $existing = Get-RunningAnchorProcess
        if (-not $existing) {
            Clear-StateFiles
            Write-Output "WSL anchor is not running."
            exit 0
        }

        [System.IO.File]::WriteAllText($stopFile, "1`n", $utf8NoBom)
        # Give the run loop time to notice the stop file and kill its wsl.exe
        # child gracefully (it polls every ~1s). Only force-kill as a last
        # resort, so the child is not orphaned.
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Milliseconds 500
            if ($existing.HasExited) {
                break
            }
        }
        if (-not $existing.HasExited) {
            Stop-Process -Id $existing.Id -Force -ErrorAction SilentlyContinue
        }
        Clear-StateFiles
        Write-Output "WSL anchor stopped."
        exit 0
    }

    "status" {
        $existing = Get-RunningAnchorProcess
        if ($existing) {
            Write-Output "WSL anchor: RUNNING (PID $($existing.Id))"
        } else {
            Write-Output "WSL anchor: STOPPED"
        }
        exit 0
    }
}
