param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\build'),
  [string]$TraySourcePath = (Join-Path $PSScriptRoot '..\electron\trayIcon.ts'),
  [string]$PublicPngPath = (Join-Path $PSScriptRoot '..\public\app-icon.png'),
  [string]$ContactSheetPath = ''
)

# Windows PowerShell + System.Drawing only. All artwork, including PDF lettering,
# is geometric: no installed fonts, external artwork, or image tools are needed.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$utf8 = [System.Text.UTF8Encoding]::new($false)
$sizes = @(16, 24, 32, 48, 64, 128, 256)

function New-RoundedPath {
  param([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius)
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $Radius * 2
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $Width - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $Width - $d, $Y + $Height - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $Height - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-PolygonPath {
  param([float[]]$Coordinates)
  $points = for ($i = 0; $i -lt $Coordinates.Length; $i += 2) {
    [System.Drawing.PointF]::new($Coordinates[$i], $Coordinates[$i + 1])
  }
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddPolygon([System.Drawing.PointF[]]$points)
  return $path
}

function Fill-Shape {
  param($Graphics, $Path, [string]$Color)
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($Color))
  try { $Graphics.FillPath($brush, $Path) } finally { $brush.Dispose(); $Path.Dispose() }
}

# Single source for the application glyph: charcoal binding, two warm leaves,
# one vermilion ribbon. The PDF document association remains a distinct file glyph.
function Draw-BoundVolume {
  param($Graphics, [bool]$Small)
  $tile = New-RoundedPath 7 8 242 240 48
  $tileBrush = [Drawing.Drawing2D.LinearGradientBrush]::new([Drawing.PointF]::new(34,12),[Drawing.PointF]::new(223,247),[Drawing.ColorTranslator]::FromHtml('#4B4944'),[Drawing.ColorTranslator]::FromHtml('#282925'))
  try { $Graphics.FillPath($tileBrush,$tile) } finally { $tileBrush.Dispose(); $tile.Dispose() }
  $state = $Graphics.Save()
  if ($Small) { $Graphics.TranslateTransform(-8,-9); $Graphics.ScaleTransform(1.06,1.06) }
  try {
    $cover = [Drawing.Drawing2D.GraphicsPath]::new()
    $cover.AddBezier(29,82,60,68,100,72,128,88)
    $cover.AddBezier(128,88,157,72,195,70,226,79)
    $cover.AddLine(226,79,226,190)
    $cover.AddBezier(226,190,195,181,160,182,135,200)
    $cover.AddBezier(135,200,131,205,125,205,121,200)
    $cover.AddBezier(121,200,96,184,57,181,29,194); $cover.CloseFigure()
    Fill-Shape $Graphics $cover '#938A78'
    $edges = [Drawing.Drawing2D.GraphicsPath]::new()
    $edges.AddBezier(35,76,65,64,101,66,128,83); $edges.AddBezier(128,83,153,66,189,61,221,73)
    $edges.AddLine(221,73,221,182); $edges.AddBezier(221,182,186,174,150,180,128,196)
    $edges.AddBezier(128,196,102,179,65,174,35,185); $edges.CloseFigure(); Fill-Shape $Graphics $edges '#C3BBA9'
    $gutter = if ($Small) { 6 } else { 2 }
    $lx=128-$gutter; $rx=128+$gutter
    $l=[Drawing.Drawing2D.GraphicsPath]::new(); $l.AddBezier(36,66,66,55,101,57,$lx,75); $l.AddLine($lx,75,$lx,185); $l.AddBezier($lx,185,101,167,66,161,36,173);$l.CloseFigure()
    $r=[Drawing.Drawing2D.GraphicsPath]::new(); $r.AddBezier($rx,75,155,56,189,55,219,63); $r.AddLine(219,63,219,171); $r.AddBezier(219,171,186,162,154,169,$rx,185); $r.CloseFigure()
    $lb=[Drawing.Drawing2D.LinearGradientBrush]::new([Drawing.PointF]::new(37,100),[Drawing.PointF]::new(132,102),[Drawing.ColorTranslator]::FromHtml('#FFFDF5'),[Drawing.ColorTranslator]::FromHtml('#DBD6C7'))
    $rb=[Drawing.Drawing2D.LinearGradientBrush]::new([Drawing.PointF]::new(132,103),[Drawing.PointF]::new(216,100),[Drawing.ColorTranslator]::FromHtml('#E9E4D7'),[Drawing.ColorTranslator]::FromHtml('#FFFDF6'))
    try { $Graphics.FillPath($lb,$l);$Graphics.FillPath($rb,$r) } finally { $lb.Dispose();$rb.Dispose();$l.Dispose();$r.Dispose() }
    if (-not $Small) {
      $rule=[Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#B8B0A1'),3)
      try { $Graphics.DrawBezier($rule,55,99,71,96,91,100,105,105);$Graphics.DrawBezier($rule,55,111,72,108,88,112,99,116) } finally {$rule.Dispose()}
    }
    $x=if($Small){156}else{163};$right=if($Small){185}else{181}
    Fill-Shape $Graphics (New-PolygonPath @($x,64,$right,60,$right,194,173,185,$x,197)) '#A34E40'
    if (-not $Small) { Fill-Shape $Graphics (New-PolygonPath @(163,64,166,63,166,193,163,197)) '#B86856' }
  } finally { $Graphics.Restore($state) }
}

function New-IconPng {
  param([int]$Size, [bool]$Association)
  # Render each size independently at 4x, not by shrinking the large icon.
  # At 16/24px omit lettering and rules; enlarge the folded-paper silhouette.
  $bitmap = [System.Drawing.Bitmap]::new($Size * 4, $Size * 4, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $small = $Size -le 24
  try {
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.ScaleTransform([float]($Size * 4 / 256), [float]($Size * 4 / 256))
    if (-not $Association) { Draw-BoundVolume $g $small } else {
    $state = $g.Save()
    if ($Association) { $g.TranslateTransform(-24, -32); $g.ScaleTransform(1.2, 1.2) }
    elseif ($small) { $g.TranslateTransform(-8, -9); $g.ScaleTransform(1.06, 1.06) }

    # One sheet only. The cut corner and triangular fold remain recognizable small.
    $page = New-PolygonPath @(64,42, 151,42, 192,83, 192,207, 64,207)
    if ($Association) {
      $outline = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#B7BFC9'), 4)
      $outline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      try { $g.DrawPath($outline, $page) } finally { $outline.Dispose() }
    }
    Fill-Shape $g $page '#FFFFFF'
    Fill-Shape $g (New-PolygonPath @(151,42, 192,83, 151,83)) '#E0B5C0'

    if (-not $small) {
      Fill-Shape $g (New-RoundedPath 83 101 76 7 3.5) '#BA687D'
      Fill-Shape $g (New-RoundedPath 83 117 53 7 3.5) '#BA687D'
    }
    Fill-Shape $g (New-RoundedPath 46 140 164 55 9) '#A91638'
    if (-not $small) {
      # Bold geometric P, D and F, with counters cut out using Alternate fill.
      $letters = $g.Save()
      $g.TranslateTransform(76, 150)
      $p = New-PolygonPath @(0,0, 22,0, 28,6, 28,18, 22,24, 8,24, 8,36, 0,36)
      $p.AddRectangle([System.Drawing.RectangleF]::new(8,7,12,10))
      Fill-Shape $g $p '#FFFFFF'
      $g.TranslateTransform(37, 0)
      $d = New-PolygonPath @(0,0, 19,0, 29,9, 29,27, 19,36, 0,36)
      $d.AddPolygon([System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(8,7), [System.Drawing.PointF]::new(16,7),
        [System.Drawing.PointF]::new(21,12), [System.Drawing.PointF]::new(21,24),
        [System.Drawing.PointF]::new(16,29), [System.Drawing.PointF]::new(8,29)))
      Fill-Shape $g $d '#FFFFFF'
      $g.TranslateTransform(38, 0)
      Fill-Shape $g (New-PolygonPath @(0,0, 28,0, 28,8, 8,8, 8,15, 24,15, 24,23, 8,23, 8,36, 0,36)) '#FFFFFF'
      $g.Restore($letters)
    }
    $g.Restore($state)
    }

    $result = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $down = [System.Drawing.Graphics]::FromImage($result)
    $stream = [System.IO.MemoryStream]::new()
    try {
      $down.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $down.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $down.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $down.DrawImage($bitmap, [System.Drawing.Rectangle]::new(0, 0, $Size, $Size))
      $result.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      return ,$stream.ToArray()
    } finally { $stream.Dispose(); $down.Dispose(); $result.Dispose() }
  } finally { $g.Dispose(); $bitmap.Dispose() }
}

function Write-Icon {
  param([string]$Path, $Frames)
  $stream = [System.IO.MemoryStream]::new()
  $writer = [System.IO.BinaryWriter]::new($stream)
  try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    foreach ($size in $sizes) {
      $dimension = if ($size -eq 256) { 0 } else { $size }
      $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
      $writer.Write([byte]0); $writer.Write([byte]0)
      $writer.Write([uint16]1); $writer.Write([uint16]32)
      $writer.Write([uint32]$Frames[$size].Length); $writer.Write([uint32]$offset)
      $offset += $Frames[$size].Length
    }
    foreach ($size in $sizes) { $writer.Write([byte[]]$Frames[$size]) }
    $writer.Flush()
    [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
  } finally { $writer.Dispose(); $stream.Dispose() }
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
$app = @{}; $pdf = @{}
foreach ($size in $sizes) {
  $app[$size] = New-IconPng $size $false
  $pdf[$size] = New-IconPng $size $true
}
Write-Icon (Join-Path $resolvedOutput 'icon.ico') $app
Write-Icon (Join-Path $resolvedOutput 'pdf.ico') $pdf
[System.IO.File]::WriteAllBytes((Join-Path $resolvedOutput 'icon.png'), $app[256])
[System.IO.File]::WriteAllBytes((Join-Path $resolvedOutput 'icon-preview-128.png'), $app[128])
[System.IO.File]::WriteAllBytes((Join-Path $resolvedOutput 'pdf-icon-preview-128.png'), $pdf[128])

# Copy exact encoded frames, never separately resize the tray or renderer icon.
if ($TraySourcePath) {
  $base64 = [System.Convert]::ToBase64String($app[16])
  $source = "/** Generated by scripts/generate-app-icon.ps1; exact 16px build/icon.ico frame.`n * Real PNG bytes keep the Windows tray visible and work inside asar. */`nexport const TRAY_ICON_PNG_DATA_URL = 'data:image/png;base64,$base64'`n"
  [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($TraySourcePath), $source, $utf8)
}
if ($PublicPngPath) {
  $publicPath = [System.IO.Path]::GetFullPath($PublicPngPath)
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($publicPath)) | Out-Null
  [System.IO.File]::WriteAllBytes($publicPath, $app[256])
  foreach ($s in @(32,64)) {
    [System.IO.File]::WriteAllBytes((Join-Path ([System.IO.Path]::GetDirectoryName($publicPath)) ("app-icon-{0}.png" -f $s)), $app[$s])
  }
}

# Optional review sheet: columns are 16/24/32/48/64/128/256px, at actual size;
# rows are application light/dark, then association light/dark. No font required.
if ($ContactSheetPath) {
  $sheet = [System.Drawing.Bitmap]::new(1120, 1120)
  $sg = [System.Drawing.Graphics]::FromImage($sheet)
  try {
    for ($row = 0; $row -lt 4; $row++) {
      $bg = if ($row % 2 -eq 0) { '#F3F4F6' } else { '#20232B' }
      $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($bg))
      try { $sg.FillRectangle($brush, 0, $row * 280, 1120, 280) } finally { $brush.Dispose() }
      $x = 20
      foreach ($size in $sizes) {
        $frames = if ($row -lt 2) { $app } else { $pdf }
        $ms = [System.IO.MemoryStream]::new([byte[]]$frames[$size])
        $image = [System.Drawing.Image]::FromStream($ms)
        try { $sg.DrawImageUnscaled($image, $x, $row * 280 + [int]((280 - $size) / 2)) }
        finally { $image.Dispose(); $ms.Dispose() }
        $x += [Math]::Max(108, $size + 24)
      }
    }
    $sheet.Save([System.IO.Path]::GetFullPath($ContactSheetPath), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $sg.Dispose(); $sheet.Dispose() }
}
Write-Output "Generated seven-frame icons and matching PNG assets in $resolvedOutput"
