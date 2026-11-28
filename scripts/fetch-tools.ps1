param(
    [switch] $VerifyOnly,
    [string] $ToolsDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'tools/tool-versions.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.platform -ne 'win32-x64') {
    throw 'Unsupported tools manifest.'
}

if (-not $ToolsDirectory) {
    $ToolsDirectory = Join-Path $repoRoot 'tools'
}
$ToolsDirectory = [System.IO.Path]::GetFullPath($ToolsDirectory)
if (-not (Test-Path -LiteralPath $ToolsDirectory -PathType Container)) {
    if ($VerifyOnly) { throw "Tools directory does not exist: $ToolsDirectory. Run powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-tools.ps1 before packaging." }
    New-Item -ItemType Directory -Path $ToolsDirectory | Out-Null
}

function Assert-Sha256([string] $Path, [string] $Expected) {
    if ($Expected -notmatch '^[a-fA-F0-9]{64}$') { throw "Invalid SHA-256 in manifest: $Expected" }
    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $actual = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
    if ($actual -ine $Expected) {
        throw "SHA-256 mismatch for $Path`: expected $Expected, got $actual"
    }
}

function Test-Sha256([string] $Path, [string] $Expected) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        Assert-Sha256 $Path $Expected
        return $true
    } catch {
        Write-Warning $_.Exception.Message
        return $false
    }
}

function Get-VerifiedFile([string] $Url, [string] $Destination, [string] $Expected) {
    if ($Url -notmatch '^https://github\.com/') { throw "Unexpected download host: $Url" }
    Write-Host "Downloading $Url"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Destination -MaximumRedirection 10 -UseBasicParsing -TimeoutSec 300
            break
        } catch {
            if ($attempt -eq 3) { throw }
            Write-Warning "Download attempt $attempt failed. Retrying $Url"
            Start-Sleep -Seconds $attempt
        }
    }
    Assert-Sha256 $Destination $Expected
}

$ytPath = Join-Path $ToolsDirectory 'yt-dlp.exe'
$ffmpegPath = Join-Path $ToolsDirectory 'ffmpeg.exe'
$ytValid = Test-Sha256 $ytPath $manifest.ytDlp.sha256
$ffmpegValid = Test-Sha256 $ffmpegPath $manifest.ffmpeg.sha256

if ($VerifyOnly) {
    if (-not $ytValid -or -not $ffmpegValid) { throw 'Bundled tools are missing or have incorrect hashes. Run powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-tools.ps1 before packaging.' }
    Write-Host 'Both bundled tools match tools/tool-versions.json.'
    return
}
if ($ytValid -and $ffmpegValid) {
    Write-Host 'Both bundled tools already match tools/tool-versions.json.'
    return
}

$stage = Join-Path $ToolsDirectory ('.tool-download-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$ytStage = Join-Path $stage 'yt-dlp.exe'
$ffmpegArchive = Join-Path $stage 'ffmpeg.zip'
$ffmpegStage = Join-Path $stage 'ffmpeg.exe'

try {
    if (-not $ytValid) {
        Get-VerifiedFile $manifest.ytDlp.url $ytStage $manifest.ytDlp.sha256
    }
    if (-not $ffmpegValid) {
        Get-VerifiedFile $manifest.ffmpeg.archiveUrl $ffmpegArchive $manifest.ffmpeg.archiveSha256
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead($ffmpegArchive)
        try {
            $entries = @($zip.Entries | Where-Object { $_.FullName -match '(^|/)bin/ffmpeg\.exe$' })
            if ($entries.Count -ne 1) { throw "Expected one bin/ffmpeg.exe in FFmpeg archive; found $($entries.Count)." }
            $inputStream = $entries[0].Open()
            try {
                $outputStream = [System.IO.File]::Create($ffmpegStage)
                try { $inputStream.CopyTo($outputStream) }
                finally { $outputStream.Dispose() }
            } finally { $inputStream.Dispose() }
        } finally { $zip.Dispose() }
        Assert-Sha256 $ffmpegStage $manifest.ffmpeg.sha256
    }

    if (-not $ytValid) {
        Move-Item -LiteralPath $ytStage -Destination $ytPath -Force
    }
    if (-not $ffmpegValid) {
        Move-Item -LiteralPath $ffmpegStage -Destination $ffmpegPath -Force
    }
    Write-Host 'Bundled tools match tools/tool-versions.json.'
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
