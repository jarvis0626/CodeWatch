# Render the repository's SVG logo with Windows drawing APIs; no image service or extra packages.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSource = Join-Path $taskRoot 'frontend/public/favicon.svg'
$taskAssets = Join-Path $taskRoot 'desktop/assets'
[xml]$taskSvg = Get-Content -LiteralPath $taskSource -Raw
$taskViewBox = @($taskSvg.svg.viewBox -split '\s+' | ForEach-Object { [float]::Parse($_, [Globalization.CultureInfo]::InvariantCulture) })
if ($taskViewBox.Count -ne 4 -or $taskViewBox[0] -ne 0 -or $taskViewBox[1] -ne 0 -or $taskViewBox[2] -ne $taskViewBox[3]) {
    throw 'The application logo must have a square viewBox starting at 0,0.'
}
$taskRect = $taskSvg.svg.rect
$taskStroke = $taskSvg.svg.path
if (-not $taskRect -or -not $taskStroke -or $taskStroke.fill -ne 'none' -or $taskStroke.'stroke-linecap' -ne 'round' -or $taskStroke.'stroke-linejoin' -ne 'round') {
    throw 'Unsupported logo shape. Update this renderer when changing the SVG structure.'
}

# The canonical logo uses relative move/line commands. Read its actual vertices instead of
# maintaining a second copy of the mark in the desktop app.
$taskTokens = @([regex]::Matches($taskStroke.d, '[A-Za-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?') | ForEach-Object { $_.Value })
if (($taskStroke.d -replace '[A-Za-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?|[\s,]', '').Length -ne 0) {
    throw 'Unsupported SVG path syntax.'
}
$taskPaths = [Collections.Generic.List[object]]::new()
$taskPoints = $null
$taskX = 0.0
$taskY = 0.0
$taskCommand = ''
for ($taskIndex = 0; $taskIndex -lt $taskTokens.Count;) {
    if ($taskTokens[$taskIndex] -cmatch '^[A-Za-z]$') {
        $taskCommand = $taskTokens[$taskIndex++]
        if ($taskCommand -cnotmatch '^[mMlL]$') { throw "Unsupported SVG path command: $taskCommand" }
        if ($taskCommand -cmatch '^[mM]$') {
            $taskPoints = [Collections.Generic.List[Drawing.PointF]]::new()
            $taskPaths.Add($taskPoints)
        }
    }
    if ($null -eq $taskPoints -or $taskIndex + 1 -ge $taskTokens.Count -or $taskTokens[$taskIndex + 1] -cmatch '^[A-Za-z]$') {
        throw 'The SVG path must contain complete coordinate pairs.'
    }
    $taskNextX = [float]::Parse($taskTokens[$taskIndex++], [Globalization.CultureInfo]::InvariantCulture)
    $taskNextY = [float]::Parse($taskTokens[$taskIndex++], [Globalization.CultureInfo]::InvariantCulture)
    if ($taskCommand -cmatch '^[ml]$') { $taskX += $taskNextX; $taskY += $taskNextY }
    else { $taskX = $taskNextX; $taskY = $taskNextY }
    $taskPoints.Add([Drawing.PointF]::new($taskX, $taskY))
    if ($taskCommand -ceq 'm') { $taskCommand = 'l' }
    elseif ($taskCommand -ceq 'M') { $taskCommand = 'L' }
}
if (@($taskPaths | Where-Object { $_.Count -lt 2 }).Count -gt 0) { throw 'Each logo stroke needs at least two points.' }

function Render-CodeWatchIcon([int]$Size) {
    # Supersampling keeps the rounded ends and corners clear in small Explorer/taskbar icons.
    $taskSurfaceSize = $Size * 4
    $taskSurface = [Drawing.Bitmap]::new($taskSurfaceSize, $taskSurfaceSize, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $taskGraphics = [Drawing.Graphics]::FromImage($taskSurface)
    $taskRoundedRect = [Drawing.Drawing2D.GraphicsPath]::new()
    $taskBrush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($taskRect.fill))
    $taskPen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml($taskStroke.stroke), [float]$taskStroke.'stroke-width')
    $taskResult = $null
    $taskOutputGraphics = $null
    try {
        $taskGraphics.Clear([Drawing.Color]::Transparent)
        $taskGraphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $taskGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $taskGraphics.ScaleTransform($taskSurfaceSize / $taskViewBox[2], $taskSurfaceSize / $taskViewBox[3])
        $taskWidth = [float]$taskRect.width
        $taskHeight = [float]$taskRect.height
        $taskDiameter = [float]$taskRect.rx * 2
        $taskRoundedRect.AddArc(0, 0, $taskDiameter, $taskDiameter, 180, 90)
        $taskRoundedRect.AddArc($taskWidth - $taskDiameter, 0, $taskDiameter, $taskDiameter, 270, 90)
        $taskRoundedRect.AddArc($taskWidth - $taskDiameter, $taskHeight - $taskDiameter, $taskDiameter, $taskDiameter, 0, 90)
        $taskRoundedRect.AddArc(0, $taskHeight - $taskDiameter, $taskDiameter, $taskDiameter, 90, 90)
        $taskRoundedRect.CloseFigure()
        $taskGraphics.FillPath($taskBrush, $taskRoundedRect)
        $taskPen.StartCap = [Drawing.Drawing2D.LineCap]::Round
        $taskPen.EndCap = [Drawing.Drawing2D.LineCap]::Round
        $taskPen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
        foreach ($taskLine in $taskPaths) { $taskGraphics.DrawLines($taskPen, [Drawing.PointF[]]$taskLine.ToArray()) }

        $taskResult = [Drawing.Bitmap]::new($Size, $Size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $taskOutputGraphics = [Drawing.Graphics]::FromImage($taskResult)
        $taskOutputGraphics.Clear([Drawing.Color]::Transparent)
        $taskOutputGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $taskOutputGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $taskOutputGraphics.DrawImage($taskSurface, [Drawing.Rectangle]::new(0, 0, $Size, $Size))
        $taskBuffer = [IO.MemoryStream]::new()
        try { $taskResult.Save($taskBuffer, [Drawing.Imaging.ImageFormat]::Png); return ,$taskBuffer.ToArray() }
        finally { $taskBuffer.Dispose() }
    }
    finally {
        if ($taskOutputGraphics) { $taskOutputGraphics.Dispose() }
        if ($taskResult) { $taskResult.Dispose() }
        $taskPen.Dispose(); $taskBrush.Dispose(); $taskRoundedRect.Dispose(); $taskGraphics.Dispose(); $taskSurface.Dispose()
    }
}

[IO.Directory]::CreateDirectory($taskAssets) | Out-Null
$taskSizes = @(16, 24, 32, 48, 64, 128, 256)
$taskImages = @($taskSizes | ForEach-Object { ,(Render-CodeWatchIcon $_) })
$taskIcoStream = [IO.MemoryStream]::new()
$taskWriter = [IO.BinaryWriter]::new($taskIcoStream)
try {
    # ICONDIR followed by one ICONDIRENTRY per PNG. Windows Vista+ supports PNG icon frames.
    $taskWriter.Write([uint16]0)
    $taskWriter.Write([uint16]1)
    $taskWriter.Write([uint16]$taskSizes.Count)
    $taskOffset = 6 + 16 * $taskSizes.Count
    for ($taskFrame = 0; $taskFrame -lt $taskSizes.Count; $taskFrame++) {
        $taskDimension = if ($taskSizes[$taskFrame] -eq 256) { 0 } else { $taskSizes[$taskFrame] }
        $taskWriter.Write([byte]$taskDimension); $taskWriter.Write([byte]$taskDimension)
        $taskWriter.Write([byte]0); $taskWriter.Write([byte]0)
        $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]32)
        $taskWriter.Write([uint32]$taskImages[$taskFrame].Length); $taskWriter.Write([uint32]$taskOffset)
        $taskOffset += $taskImages[$taskFrame].Length
    }
    foreach ($taskImage in $taskImages) { $taskWriter.Write([byte[]]$taskImage) }
    $taskWriter.Flush()
    [IO.File]::WriteAllBytes((Join-Path $taskAssets 'codewatch.ico'), $taskIcoStream.ToArray())
    $taskLargeIcon = Render-CodeWatchIcon 512
    [IO.File]::WriteAllBytes((Join-Path $taskAssets 'codewatch.png'), $taskLargeIcon)
    [IO.File]::WriteAllBytes((Join-Path $taskRoot 'frontend/public/phone-icon-192.png'), (Render-CodeWatchIcon 192))
    [IO.File]::WriteAllBytes((Join-Path $taskRoot 'frontend/public/phone-icon-512.png'), $taskLargeIcon)
    Write-Host 'Generated desktop PNG, Windows ICO (16, 24, 32, 48, 64, 128, 256px), and phone icons from favicon.svg.'
}
finally { $taskWriter.Dispose(); $taskIcoStream.Dispose() }
