$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourcePath = Join-Path $projectRoot 'TelopotifyApp\assets\telopotify-logo.png'
$packageImages = Join-Path $projectRoot 'TelopotifyApp\windows\TelopotifyApp.Package\Images'
$nativeImages = Join-Path $projectRoot 'TelopotifyApp\windows\TelopotifyApp'
$source = [System.Drawing.Bitmap]::new($sourcePath)

function New-IconBitmap([int]$width, [int]$height, [int]$logoSize) {
  $bitmap = [System.Drawing.Bitmap]::new($width, $height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $x = [int](($width - $logoSize) / 2)
    $y = [int](($height - $logoSize) / 2)
    $graphics.DrawImage($source, [System.Drawing.Rectangle]::new($x, $y, $logoSize, $logoSize))
  } finally { $graphics.Dispose() }
  return $bitmap
}

function Save-Png([string]$name, [int]$width, [int]$height, [int]$logoSize) {
  $bitmap = New-IconBitmap $width $height $logoSize
  try { $bitmap.Save((Join-Path $packageImages $name), [System.Drawing.Imaging.ImageFormat]::Png) }
  finally { $bitmap.Dispose() }
}

try {
  Save-Png 'StoreLogo.png' 50 50 50
  Save-Png 'Square150x150Logo.scale-200.png' 300 300 300
  Save-Png 'Square44x44Logo.scale-200.png' 88 88 88
  Save-Png 'Square44x44Logo.targetsize-24_altform-unplated.png' 24 24 24
  Save-Png 'LockScreenLogo.scale-200.png' 48 48 48
  Save-Png 'Wide310x150Logo.scale-200.png' 620 300 270
  Save-Png 'SplashScreen.scale-200.png' 1240 600 360

  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $entries = foreach ($iconSize in $sizes) {
    $bitmap = New-IconBitmap $iconSize $iconSize $iconSize
    $stream = [System.IO.MemoryStream]::new()
    try {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      ,@{ Size = $iconSize; Bytes = $stream.ToArray() }
    } finally { $stream.Dispose(); $bitmap.Dispose() }
  }
  $iconStream = [System.IO.MemoryStream]::new()
  $writer = [System.IO.BinaryWriter]::new($iconStream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$entries.Count)
    $offset = 6 + 16 * $entries.Count
    foreach ($entry in $entries) {
      $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$entry.Bytes.Length)
      $writer.Write([uint32]$offset)
      $offset += $entry.Bytes.Length
    }
    foreach ($entry in $entries) { $writer.Write([byte[]]$entry.Bytes) }
    $writer.Flush()
    $icon = $iconStream.ToArray()
    [System.IO.File]::WriteAllBytes((Join-Path $nativeImages 'small.ico'), $icon)
    [System.IO.File]::WriteAllBytes((Join-Path $nativeImages 'TelopotifyApp.ico'), $icon)
  } finally { $writer.Dispose(); $iconStream.Dispose() }
} finally { $source.Dispose() }

Write-Host 'Generated Windows package images and taskbar icons from telopotify-logo.png.'
