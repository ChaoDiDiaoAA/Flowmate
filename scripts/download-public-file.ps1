param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$TargetFile
)

$targetFullPath = [IO.Path]::GetFullPath($TargetFile)
$targetDirectory = [IO.Path]::GetDirectoryName($targetFullPath)
[IO.Directory]::CreateDirectory($targetDirectory) | Out-Null
$temporaryFile = "$targetFullPath.download"

try {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $temporaryFile -TimeoutSec 120
  Move-Item -LiteralPath $temporaryFile -Destination $targetFullPath
} catch {
  if (Test-Path -LiteralPath $temporaryFile) {
    Remove-Item -LiteralPath $temporaryFile
  }
  throw "Public file download failed"
}
