#Requires -Version 5.1
<#
.SYNOPSIS
    fdn-autosync-tray 图标合成器：底图 + 右下角状态角标 → 多尺寸 PNG。

.DESCRIPTION
    由 tray.ps1 在状态变化时以子进程方式调用：

        powershell -NoProfile -ExecutionPolicy Bypass -File icon-compose.ps1 `
            -Base <底图路径> -Badge <running|paused|success|up-to-date|failure|internal-error|none> `
            -OutDir <输出目录> [-Sizes 16,20,24,32,40,48,64]

    约定：
      * 底图支持 PNG / ICO / BMP（GDI+ 解码），缩放为正方形。
      * 角标画在右下角，边长约底图 50%。
      * 透明挖空严格按角标实际轮廓（三角 / 双竖条 / 对勾 / 圆点 / 叉）构造
        GraphicsPath 或描边笔画外扩，绝不挖正方形。
      * 每个尺寸输出 <OutDir>\icon-<size>.png。
      * 成功时 stdout 只打印一行 ASCII JSON：{"sizes":[16,20,...]}。
      * 失败时 exit 1，原因写 stderr。

    注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 才能正确读中文）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Base,

    [ValidateSet('running', 'paused', 'success', 'up-to-date', 'failure', 'internal-error', 'none')]
    [string]$Badge = 'none',

    [Parameter(Mandatory = $true)]
    [string]$OutDir,

    # 可选：把多尺寸图标直接写成一个 .ico（每个尺寸都是传统 32bpp DIB 条目，不是 PNG 帧）。
    # 原因：.NET Framework 4.8 的 System.Drawing.Icon 无法解码 PNG 压缩帧的 ICO，
    # 而托盘宿主只用 `New-Object System.Drawing.Icon($path)` 读图标，所以这里必须给 DIB 帧。
    [string]$OutIco = '',

    # 必须是 [string]：调用方是 `powershell -File ... -Sizes 16,20,24,32,40,48,64`
    # （单个字符串实参），[int[]] 参数在这种传参方式下无法完成转换，会直接报
    # "Cannot process argument transformation on parameter 'Sizes'"。
    # 在脚本内部自己按逗号拆分。
    [string]$Sizes = '16,20,24,32,40,48,64'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ============================ 几何工具 ============================

function New-PointF([double]$X, [double]$Y) {
    return (New-Object System.Drawing.PointF([single]$X, [single]$Y))
}

# 角标占位：右下角正方形，边长约底图 50%；Pad = 角标与底图之间要挖空的间隙。
function Get-BadgeBox([int]$Size) {
    $side = [double]$Size * 0.5
    # 角标必须紧贴右下角：框的留白为 0（形状自己留 6% 内边距给 1px 深色描边）。
    # 旧版这里是 max(1, size*0.02)：64px 下既有 1.3px 空白、形状内部又留 8% 内边距，
    # 视觉上就成了「角标没撑满 / 不在最角落」。
    $inset = 0.0
    return @{
        Size = [double]$Size
        Side = $side
        X    = [double]$Size - $side - $inset
        Y    = [double]$Size - $side - $inset
        Pad  = $side * 0.16
    }
}

# 多边形「按轮廓外扩」：从重心出发沿顶点方向推开 Pad，得到挖空用的轮廓，
# 形状仍是原来的多边形（不是外接矩形/外接圆）。
function New-ExpandedPolygon([System.Drawing.PointF[]]$Points, [double]$Pad) {
    $count = $Points.Count
    if ($count -eq 0) { return $Points }
    $cx = 0.0
    $cy = 0.0
    foreach ($p in $Points) {
        $cx += [double]$p.X
        $cy += [double]$p.Y
    }
    $cx = $cx / $count
    $cy = $cy / $count
    $out = New-Object 'System.Drawing.PointF[]' $count
    for ($i = 0; $i -lt $count; $i++) {
        $p = $Points[$i]
        $dx = [double]$p.X - $cx
        $dy = [double]$p.Y - $cy
        $len = [math]::Sqrt($dx * $dx + $dy * $dy)
        if ($len -lt 0.0001) {
            $out[$i] = $p
            continue
        }
        $factor = ($len + $Pad) / $len
        $out[$i] = New-PointF ($cx + $dx * $factor) ($cy + $dy * $factor)
    }
    return $out
}

# 注意：所有 GraphicsPath 一律用 Winding 填充规则。默认的 Alternate 会让「两个重叠矩形」
# 的重叠区按奇偶规则被排除（XOR），导致 pause 两条竖条之间的挖空带残留底图。
function Set-WindingFill([System.Drawing.Drawing2D.GraphicsPath]$Path) {
    $Path.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding
    return $Path
}

function New-FillPathPolygon([System.Drawing.PointF[]]$Points) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddPolygon($Points)
    return (Set-WindingFill $path)
}

function New-FillPathEllipse([System.Drawing.RectangleF]$Rect) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse($Rect)
    return (Set-WindingFill $path)
}

function New-FillPathRects([System.Drawing.RectangleF[]]$Rects) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    foreach ($r in $Rects) { $path.AddRectangle($r) }
    return (Set-WindingFill $path)
}

function New-RoundedPen([System.Drawing.Color]$Color, [double]$Width) {
    $pen = New-Object System.Drawing.Pen($Color, [single]$Width)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    return $pen
}

# ============================ 角标绘制 ============================

# 先沿角标实际轮廓把底图对应区域挖成透明，再画角标本体（填充 + 细描边）。
#
# 参数说明（超采样）：
#   $TargetSize  最终输出尺寸（32 / 16 …）
#   $Scale       画布倍数（固定 4）：所有坐标都在 $TargetSize*$Scale 的画布上，
#                最后再 bicubic 缩回 $TargetSize，挖空边界天然获得覆盖率抗锯齿。
#   $Cutout      $true = 沿轮廓挖空；$false = 不挖空，角标直接压在底图上（小尺寸兜底），
#                此时角标用 1px 深色描边保证可辨识。
function Add-StatusBadge([System.Drawing.Graphics]$Graphics, [string]$BadgeName, [int]$TargetSize, [int]$Scale, [bool]$Cutout) {
    if ([string]::IsNullOrEmpty($BadgeName) -or $BadgeName -eq 'none') { return }
    if ($Scale -lt 1) { $Scale = 1 }

    # 归一化：success→对勾，up-to-date→实心圆，failure/internal-error→叉
    $kind = switch ($BadgeName) {
        'success' { 'check' }
        'up-to-date' { 'dot' }
        'failure' { 'cross' }
        'internal-error' { 'cross' }
        default { $BadgeName }
    }

    # 画布坐标：角标占位随画布放大（$CanvasSize = 目标尺寸 × 4）
    $canvasSize = $TargetSize * $Scale
    $box = Get-BadgeBox $canvasSize
    $side = [double]$box.Side
    $x0 = [double]$box.X
    $y0 = [double]$box.Y

    # 挖空带宽度：按目标尺寸自适应
    #   gap = max(1, round(size * 0.045))，并夹到 1.5px 上界。
    # 上界的理由（实测扫参，见 .tmp/aa-cap-sweep.ps1）：挖空带越宽，带宽中间就越会留出
    # 「整片全透明」的核心像素，而抗锯齿过渡只在两侧各约 1px —— 64px 时 cap=2 会让
    # success/failure 的半透明过渡占比掉到 72.5%/67%，硬切 0 像素 80/123 个，
    # 在深色任务栏上就是一圈发硬的灰环。cap=1.5 时同一指标为 79%/76%（硬切 51/80），
    # 既保留了约 1~2px 的真实缝隙，又让每个挖空像素都落在覆盖率斜坡上。
    $gapTargetPx = [math]::Max(1.0, [double][math]::Round([double]$TargetSize * 0.045))
    if ($gapTargetPx -gt 1.5) { $gapTargetPx = 1.5 }
    $pad = $gapTargetPx * $Scale

    $white = [System.Drawing.Color]::FromArgb(255, 255, 255)
    $green = [System.Drawing.Color]::FromArgb(255, 46, 160, 67)
    $red = [System.Drawing.Color]::FromArgb(255, 218, 54, 51)

    # 挖空：用 SourceCopy + 全透明笔刷把底图抹成透明；
    # 不挖空：用 SourceOver + 全透明笔刷（等于什么都不做），角标直接叠在底图上。
    $clearMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    if ($Cutout) { $clearMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy }

    if ($Cutout) {
        $outlinePx = [math]::Max(0.75, [double]$TargetSize * 0.03) * $Scale
        $whiteOutline = [System.Drawing.Color]::FromArgb(96, 0, 0, 0)
        $greenOutline = [System.Drawing.Color]::FromArgb(140, 18, 96, 42)
        $redOutline = [System.Drawing.Color]::FromArgb(140, 122, 20, 18)
    }
    else {
        # 不挖空：底图仍在角标下面，必须靠深色描边把角标和底图分开
        $outlinePx = [math]::Max(1.0, [double]$TargetSize * 0.05) * $Scale
        $darkOutline = [System.Drawing.Color]::FromArgb(210, 14, 20, 16)
        $whiteOutline = $darkOutline
        $greenOutline = $darkOutline
        $redOutline = $darkOutline
    }

    # 角标外圈深色描边（照片类底图上保证可辨识）：
    # 颜色 ARGB(200,16,18,20)，净宽度 1 目标像素。做法是「先用 2px 笔宽画一圈、再让填充盖掉内侧一半」，
    # 于是只有形状外侧那 1px 是深色 —— 不额外加宽挖空带，不退回硬边。
    $edgeColor = [System.Drawing.Color]::FromArgb(200, 16, 18, 20)
    $edgePen = New-RoundedPen $edgeColor ([double]$Scale * 2.0)

    $oldMode = $Graphics.CompositingMode
    $clearBrush = $null
    $fillPath = $null
    $clearPath = $null
    $clearPen = $null
    $strokePen = $null
    $edgeStrokePen = $null
    $outlinePen = $null
    $brush = $null

    try {
        # ================= 统一锚点 =================
        # 所有形状的外接框「右下角」都贴到图标右下角：
        #   最右下目标像素 = $lastT；形状外圈（1px 深色描边）再向外 1px，正好压住图标边缘。
        # 旧实现是「在 size*0.5 的框里居中」，导致 paused 的双竖条和 up-to-date 的圆点
        # 右/下各留 2~6px 空白，看上去像「没撑满、没贴角」。
        $lastT = $TargetSize - 1
        # 形状本体（不含 1px 外圈）的右/下边界（目标像素）
        $shapeRightT = $lastT - 1
        $shapeBottomT = $lastT - 1
        # 换算到画布坐标：外沿 = (目标像素 + 1) * Scale
        $shapeRightC = [double]($shapeRightT + 1) * $Scale
        $shapeBottomC = [double]($shapeBottomT + 1) * $Scale

        switch ($kind) {
            'running' {
                # 白色右三角：外接框贴右下角
                $bwT = [math]::Max(3, [int][math]::Round([double]$TargetSize * 0.46))
                $bhT = [math]::Max(3, [int][math]::Round([double]$TargetSize * 0.46))
                $bx0 = [double]($shapeRightT + 1 - $bwT) * $Scale
                $bx1 = $shapeRightC
                $by0 = [double]($shapeBottomT + 1 - $bhT) * $Scale
                $by1 = $shapeBottomC
                $bw = $bx1 - $bx0
                $bh = $by1 - $by0

                $points = New-Object 'System.Drawing.PointF[]' 3
                # 三角上下顶点直接落在外接框上下边界（不留内缩），保证 bbox 右下角贴住图标角
                $points[0] = New-PointF $bx0 $by0
                $points[1] = New-PointF $bx0 $by1
                $points[2] = New-PointF $bx1 (($by0 + $by1) / 2.0)
                $fillPath = New-FillPathPolygon $points
                $clearPath = New-FillPathPolygon (New-ExpandedPolygon $points $pad)

                $clearBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Transparent)
                $Graphics.CompositingMode = $clearMode
                $Graphics.FillPath($clearBrush, $clearPath)
                $Graphics.CompositingMode = $oldMode

                # 深色外圈（照片底图上保证白三角可辨识）
                $Graphics.DrawPath($edgePen, $fillPath)

                $brush = New-Object System.Drawing.SolidBrush($white)
                $Graphics.FillPath($brush, $fillPath)

                $outlinePen = New-RoundedPen $whiteOutline $outlinePx
                $Graphics.DrawPath($outlinePen, $fillPath)
            }
            'paused' {
                # 白色双竖条「||」：整数像素、严格等宽、右对齐、垂直居中于自身高度。
                # 所有几何都按「目标像素」取整后再乘 4 落到画布上，因此每个 bar 的左右边界
                # 正好落在目标像素网格上 —— 低分辨率下两条线宽度完全一致（不会出现 5px vs 6px）。
                $barWT = [math]::Max(2, [int][math]::Round([double]$TargetSize * 0.11))
                $gapWT = [math]::Max(2, [int][math]::Round([double]$TargetSize * 0.06))
                # 条间距不得超过「两个挖空矩形刚好相接」的宽度，否则会在两条 bar 之间
                # 留下一条未被挖空的底图竖线（在照片底图上会很脏）。
                $gapCapT = [math]::Max(2, [int][math]::Floor(2.0 * $gapTargetPx))
                if ($gapWT -gt $gapCapT) { $gapWT = $gapCapT }
                $barHT = [math]::Max(3, [int][math]::Round([double]$TargetSize * 0.44))
                $totalWT = $barWT * 2 + $gapWT

                # 右对齐：右条右边缘 = 形状右边界
                $x0T = $shapeRightT + 1 - $totalWT
                $y0T = $shapeBottomT + 1 - $barHT

                # 画布坐标 = 目标坐标 × Scale（整数 → 与目标像素网格严格对齐）
                $barW = $barWT * $Scale
                $barH = $barHT * $Scale
                $leftX = [double]$x0T * $Scale
                $rightX = [double]($x0T + $barWT + $gapWT) * $Scale
                $barTop = [double]$y0T * $Scale
                $padInt = [int][math]::Round($pad)

                $rectA = New-Object System.Drawing.RectangleF([single]$leftX, [single]$barTop, [single]$barW, [single]$barH)
                $rectB = New-Object System.Drawing.RectangleF([single]$rightX, [single]$barTop, [single]$barW, [single]$barH)
                $fillPath = New-FillPathRects @($rectA, $rectB)

                # 挖空：两根 bar 各外扩同一个整数 pad（左右对称、与 bar 同中心）
                $clearA = New-Object System.Drawing.RectangleF(
                    [single]($leftX - $padInt), [single]($barTop - $padInt),
                    [single]($barW + 2 * $padInt), [single]($barH + 2 * $padInt))
                $clearB = New-Object System.Drawing.RectangleF(
                    [single]($rightX - $padInt), [single]($barTop - $padInt),
                    [single]($barW + 2 * $padInt), [single]($barH + 2 * $padInt))
                $clearPath = New-FillPathRects @($clearA, $clearB)

                $clearBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Transparent)
                $Graphics.CompositingMode = $clearMode
                $Graphics.FillPath($clearBrush, $clearPath)
                $Graphics.CompositingMode = $oldMode

                # 先画深色外圈（笔宽 2px，被填充盖掉内侧 1px → 净效果是外侧 1px 深色描边）
                $Graphics.DrawPath($edgePen, $fillPath)

                $brush = New-Object System.Drawing.SolidBrush($white)
                $Graphics.FillPath($brush, $fillPath)

                $outlinePen = New-RoundedPen $whiteOutline $outlinePx
                $Graphics.DrawPath($outlinePen, $fillPath)
            }
            'check' {
                # 绿色对勾：描边笔画，挖空用同一笔画加宽（形状仍是对勾，不是方块）
                $boxT = [math]::Max(4, [int][math]::Round([double]$TargetSize * 0.52))
                $sw = [math]::Max(1.5, [double]$TargetSize * 0.10) * $Scale

                $cx0 = [double]($shapeRightT + 1 - $boxT) * $Scale + $sw / 2.0
                $cx1 = $shapeRightC - $sw / 2.0
                $cy0 = [double]($shapeBottomT + 1 - $boxT) * $Scale + $sw / 2.0
                $cy1 = $shapeBottomC - $sw / 2.0
                $cw = $cx1 - $cx0
                $chh = $cy1 - $cy0

                $points = New-Object 'System.Drawing.PointF[]' 3
                $points[0] = New-PointF $cx0 ($cy0 + 0.55 * $chh)
                $points[1] = New-PointF ($cx0 + 0.40 * $cw) $cy1
                $points[2] = New-PointF $cx1 $cy0

                $clearPen = New-RoundedPen ([System.Drawing.Color]::Transparent) ($sw + 2.0 * $pad)
                $Graphics.CompositingMode = $clearMode
                $Graphics.DrawLines($clearPen, $points)
                $Graphics.CompositingMode = $oldMode

                # 深色外圈（比笔画宽 2px，内侧被笔画盖住 → 外侧只留 1px 深色）
                $edgeStrokePen = New-RoundedPen $edgeColor ($sw + 2.0 * $Scale)
                $Graphics.DrawLines($edgeStrokePen, $points)

                $strokePen = New-RoundedPen $green $sw
                $Graphics.DrawLines($strokePen, $points)

                $outlinePen = New-RoundedPen $greenOutline $outlinePx
                $Graphics.DrawLines($outlinePen, $points)
            }
            'cross' {
                # 红色叉：两条描边笔画，挖空按两条笔画各自加宽；外接框贴右下角
                $boxT = [math]::Max(4, [int][math]::Round([double]$TargetSize * 0.48))
                $sw = [math]::Max(1.5, [double]$TargetSize * 0.09) * $Scale

                $cx0 = [double]($shapeRightT + 1 - $boxT) * $Scale + $sw / 2.0
                $cx1 = $shapeRightC - $sw / 2.0
                $cy0 = [double]($shapeBottomT + 1 - $boxT) * $Scale + $sw / 2.0
                $cy1 = $shapeBottomC - $sw / 2.0

                $a = New-PointF $cx0 $cy0
                $b = New-PointF $cx1 $cy1
                $c = New-PointF $cx1 $cy0
                $d = New-PointF $cx0 $cy1

                $clearPen = New-RoundedPen ([System.Drawing.Color]::Transparent) ($sw + 2.0 * $pad)
                $Graphics.CompositingMode = $clearMode
                $Graphics.DrawLine($clearPen, $a, $b)
                $Graphics.DrawLine($clearPen, $c, $d)
                $Graphics.CompositingMode = $oldMode

                # 深色外圈（同 check）
                $edgeStrokePen = New-RoundedPen $edgeColor ($sw + 2.0 * $Scale)
                $Graphics.DrawLine($edgeStrokePen, $a, $b)
                $Graphics.DrawLine($edgeStrokePen, $c, $d)

                $strokePen = New-RoundedPen $red $sw
                $Graphics.DrawLine($strokePen, $a, $b)
                $Graphics.DrawLine($strokePen, $c, $d)

                $outlinePen = New-RoundedPen $redOutline $outlinePx
                $Graphics.DrawLine($outlinePen, $a, $b)
                $Graphics.DrawLine($outlinePen, $c, $d)
            }
            'dot' {
                # 绿色实心圆点：直径 0.40 * size，右下对齐
                $dT = [math]::Max(3, [int][math]::Round([double]$TargetSize * 0.40))
                $dx0 = [double]($shapeRightT + 1 - $dT) * $Scale
                $dy0 = [double]($shapeBottomT + 1 - $dT) * $Scale
                $dC = [double]$dT * $Scale

                $rect = New-Object System.Drawing.RectangleF([single]$dx0, [single]$dy0, [single]$dC, [single]$dC)
                $fillPath = New-FillPathEllipse $rect

                $clearRect = New-Object System.Drawing.RectangleF([single]$rect.X, [single]$rect.Y, [single]$rect.Width, [single]$rect.Height)
                $clearRect.Inflate([single]$pad, [single]$pad)
                $clearPath = New-FillPathEllipse $clearRect

                $clearBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Transparent)
                $Graphics.CompositingMode = $clearMode
                $Graphics.FillPath($clearBrush, $clearPath)
                $Graphics.CompositingMode = $oldMode

                # 深色外圈（圆点同理：2px 笔宽的圆环，被填充盖掉内侧一半 → 外侧 1px 深色）
                $Graphics.DrawPath($edgePen, $fillPath)

                $brush = New-Object System.Drawing.SolidBrush($green)
                $Graphics.FillPath($brush, $fillPath)

                $outlinePen = New-RoundedPen $greenOutline $outlinePx
                $Graphics.DrawPath($outlinePen, $fillPath)
            }
            default {
                throw "未知角标类型：$BadgeName"
            }
        }

    }
    finally {
        $Graphics.CompositingMode = $oldMode
        foreach ($obj in @($clearBrush, $brush, $clearPen, $strokePen, $edgeStrokePen, $edgePen, $outlinePen, $fillPath, $clearPath)) {
            if ($null -ne $obj) {
                try { $obj.Dispose() } catch { }
            }
        }
    }
}

# ============================ 底图 ============================

# 把任意 Image 复制成独立的 32bpp 位图（随后即可释放原 Image / 文件句柄）。
function Copy-ImageTo32bpp([System.Drawing.Image]$Image) {
    $bitmap = New-Object System.Drawing.Bitmap($Image.Width, $Image.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = $null
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.DrawImage($Image, 0, 0, $Image.Width, $Image.Height)
    }
    finally {
        if ($null -ne $graphics) { try { $graphics.Dispose() } catch { } }
    }
    return $bitmap
}

# 读取 ICO 目录，返回所有帧的元数据（不做解码）。
function Get-IcoFrameTable([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 6) { throw "ICO 文件过短：$Path" }
    $reserved = [System.BitConverter]::ToUInt16($bytes, 0)
    $type = [System.BitConverter]::ToUInt16($bytes, 2)
    $count = [System.BitConverter]::ToUInt16($bytes, 4)
    if ($reserved -ne 0 -or $type -ne 1 -or $count -le 0) { throw "不是有效的 ICO 文件：$Path" }

    $frames = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $count; $i++) {
        $entry = 6 + $i * 16
        if ($entry + 16 -gt $bytes.Length) { break }
        $width = [int]$bytes[$entry]
        if ($width -eq 0) { $width = 256 }
        $height = [int]$bytes[$entry + 1]
        if ($height -eq 0) { $height = 256 }
        $length = [int][System.BitConverter]::ToUInt32($bytes, $entry + 8)
        $offset = [int][System.BitConverter]::ToUInt32($bytes, $entry + 12)
        if ($offset -le 0 -or $length -le 0 -or ($offset + $length) -gt $bytes.Length) { continue }
        $isPng = $false
        if ($length -ge 8) {
            $isPng = ($bytes[$offset] -eq 0x89 -and $bytes[$offset + 1] -eq 0x50 -and `
                    $bytes[$offset + 2] -eq 0x4E -and $bytes[$offset + 3] -eq 0x47)
        }
        [void]$frames.Add(@{
                Width  = $width
                Height = $height
                IsPng  = $isPng
                Offset = $offset
                Length = $length
                Pixels = ($width * $height)
            })
    }
    return $frames
}

# 用 PNG 帧字节解出底图（System.Drawing.Icon 在 .NET Framework 上无法解码 PNG 帧）。
function Read-PngFrameImage([byte[]]$Bytes, [int]$Offset, [int]$Length) {
    $buffer = New-Object 'byte[]' $Length
    [System.Array]::Copy($Bytes, $Offset, $buffer, 0, $Length)
    $stream = New-Object System.IO.MemoryStream($buffer, $false)
    $image = $null
    try {
        $image = [System.Drawing.Image]::FromStream($stream)
        return (Copy-ImageTo32bpp $image)
    }
    finally {
        if ($null -ne $image) { try { $image.Dispose() } catch { } }
        $stream.Dispose()
    }
}

# 底图支持 ICO / PNG / BMP：统一解码成 32bpp 位图，避免长期占用文件句柄。
function Read-BaseImage([string]$Path) {
    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()

    if ($ext -eq '.ico') {
        $frames = Get-IcoFrameTable $Path
        if ($frames.Count -eq 0) { throw "ICO 里没有可用帧：$Path" }

        # 优先取最大帧，避免拿 16x16 放大变糊
        $largest = $frames[0]
        foreach ($f in $frames) { if ($f.Pixels -gt $largest.Pixels) { $largest = $f } }

        $bytes = $null
        if ($largest.IsPng) {
            $bytes = [System.IO.File]::ReadAllBytes($Path)
            return (Read-PngFrameImage $bytes $largest.Offset $largest.Length)
        }

        # DIB 帧：System.Drawing.Icon 能处理，但需要按尺寸逐个试（不支持的尺寸会抛异常）
        $best = $null
        foreach ($requested in @(256, 128, 96, 64, 48, 40, 32, 24, 20, 16)) {
            $candidate = $null
            try {
                $candidate = New-Object System.Drawing.Icon($Path, $requested, $requested)
            }
            catch {
                $candidate = $null
            }
            if ($null -eq $candidate) { continue }
            $okBitmap = $null
            try {
                $okBitmap = $candidate.ToBitmap()
            }
            catch {
                $okBitmap = $null
            }
            if ($null -eq $okBitmap) {
                try { $candidate.Dispose() } catch { }
                continue
            }
            if ($null -eq $best) {
                $best = $okBitmap
                try { $candidate.Dispose() } catch { }
                if ($best.Width -ge $largest.Width) { break }
                continue
            }
            if (($okBitmap.Width * $okBitmap.Height) -gt ($best.Width * $best.Height)) {
                try { $best.Dispose() } catch { }
                $best = $okBitmap
                try { $candidate.Dispose() } catch { }
            }
            else {
                try { $okBitmap.Dispose() } catch { }
                try { $candidate.Dispose() } catch { }
            }
        }

        if ($null -ne $best) {
            try { return (Copy-ImageTo32bpp $best) }
            finally { try { $best.Dispose() } catch { } }
        }

        # 全部 DIB 帧都解不出来：退回 PNG 帧
        $pngFrame = $null
        foreach ($f in $frames) {
            if (-not $f.IsPng) { continue }
            if ($null -eq $pngFrame -or $f.Pixels -gt $pngFrame.Pixels) { $pngFrame = $f }
        }
        if ($null -ne $pngFrame) {
            $bytes = [System.IO.File]::ReadAllBytes($Path)
            return (Read-PngFrameImage $bytes $pngFrame.Offset $pngFrame.Length)
        }
        throw "无法从 ICO 解码底图：$Path"
    }

    # PNG / BMP（以及 .jfif 之类 GDI+ 能解的位图）
    $source = $null
    try {
        $source = [System.Drawing.Image]::FromFile($Path)
        return (Copy-ImageTo32bpp $source)
    }
    finally {
        if ($null -ne $source) { try { $source.Dispose() } catch { } }
    }
}

# ============================ 单尺寸合成 ============================

# 超采样倍数：所有形状与挖空都在 4× 画布上绘制，最后 bicubic 缩回目标尺寸。
# 好处：挖空边界由「覆盖率抗锯齿」自然产生，不必手工羽化，也不会出现硬切的 1px 灰圈。
$script:Supersample = 4

# 把底图按等比（contain）方式画进画布矩形
function Draw-BaseImageTo([System.Drawing.Graphics]$Graphics, [System.Drawing.Image]$BaseImage, [int]$CanvasWidth, [int]$CanvasHeight) {
    if ($null -eq $BaseImage) { return }
    $scale = [math]::Min([double]$CanvasWidth / [double]$BaseImage.Width, [double]$CanvasHeight / [double]$BaseImage.Height)
    $w = [math]::Max(1, [int][math]::Round([double]$BaseImage.Width * $scale))
    $h = [math]::Max(1, [int][math]::Round([double]$BaseImage.Height * $scale))
    $left = [int][math]::Floor(($CanvasWidth - $w) / 2.0)
    $top = [int][math]::Floor(($CanvasHeight - $h) / 2.0)
    $Graphics.DrawImage($BaseImage, $left, $top, $w, $h)
}

# 用 bicubic 把 4× 画布缩回目标尺寸（缩小后不再叠任何描边）
function Resample-Down([System.Drawing.Bitmap]$Canvas, [int]$Size) {
    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $attributes = New-Object System.Drawing.Imaging.ImageAttributes
    try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)
        # TileFlipXY：避免 bicubic 在边缘采样画布外像素造成的边缘暗边
        $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $destRect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
        $graphics.DrawImage(
            $Canvas,
            $destRect,
            0, 0, $Canvas.Width, $Canvas.Height,
            [System.Drawing.GraphicsUnit]::Pixel,
            $attributes)
    }
    finally {
        $attributes.Dispose()
        $graphics.Dispose()
    }
    return $bitmap
}

function New-ComposedBitmap {
    param(
        [System.Drawing.Image]$BaseImage,
        [string]$BadgeName,
        [int]$Size,
        [bool]$Cutout = $true
    )
    $scale = [int]$script:Supersample
    $canvasWidth = $Size * $scale

    # ---- 1) 在 4× 画布上画底图 + 角标（含挖空）----
    $canvas = New-Object System.Drawing.Bitmap($canvasWidth, $canvasWidth, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)

        Draw-BaseImageTo -Graphics $graphics -BaseImage $BaseImage -CanvasWidth $canvasWidth -CanvasHeight $canvasWidth
        Add-StatusBadge -Graphics $graphics -BadgeName $BadgeName -TargetSize $Size -Scale $scale -Cutout $Cutout
    }
    finally {
        $graphics.Dispose()
    }

    # ---- 2) bicubic 缩回目标尺寸 ----
    try {
        return (Resample-Down $canvas $Size)
    }
    finally {
        $canvas.Dispose()
    }
}

# ============================ ICO 打包（传统 32bpp DIB 条目） ============================
#
# 为什么不用 PNG 帧：System.Drawing.Icon（.NET Framework 4.8）无法解码 PNG 压缩帧的 ICO，
# ToBitmap()/Handle 会抛 "Requested range extends past the end of the array"。
# 所以这里直接写经典 DIB 条目：BITMAPINFOHEADER + 自下而上的 BGRA 像素 + 1bpp AND 掩码，
# 这样 New-Object System.Drawing.Icon($path) 一定能读出来，且透明通道完整。
# （也不用 Bitmap.GetHicon()：那条路会额外产生需要 DestroyIcon 的句柄，且半透明边缘可能被压平。）

function Get-IconDibEntry {
    param([System.Drawing.Bitmap]$Bitmap)
    $size = $Bitmap.Width
    $stride = $size * 4
    $maskStride = [int]([math]::Floor(($size + 31) / 32) * 4)
    $xor = New-Object 'byte[]' ($stride * $size)
    $mask = New-Object 'byte[]' ($maskStride * $size)

    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $Bitmap.Height)
    $locked = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $bytes = New-Object 'byte[]' ($locked.Stride * $size)
        [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $bytes, 0, $bytes.Length)
        for ($y = 0; $y -lt $size; $y++) {
            $srcRow = $y * $locked.Stride
            $dstRow = ($size - 1 - $y) * $stride       # DIB 自下而上
            $maskRow = ($size - 1 - $y) * $maskStride
            for ($x = 0; $x -lt $size; $x++) {
                $s = $srcRow + $x * 4
                $d = $dstRow + $x * 4
                $xor[$d] = $bytes[$s]
                $xor[$d + 1] = $bytes[$s + 1]
                $xor[$d + 2] = $bytes[$s + 2]
                $xor[$d + 3] = $bytes[$s + 3]
                if ($bytes[$s + 3] -lt 128) {
                    $col = [int]([math]::Floor($x / 8))
                    $mask[$maskRow + $col] = $mask[$maskRow + $col] -bor (1 -shl (7 - ($x % 8)))
                }
            }
        }
    }
    finally {
        $Bitmap.UnlockBits($locked)
    }

    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    try {
        $writer.Write([int]40)                      # biSize
        $writer.Write([int]$size)                   # biWidth
        $writer.Write([int]($size * 2))              # biHeight（XOR + AND）
        $writer.Write([int16]1)                     # biPlanes
        $writer.Write([int16]32)                    # biBitCount
        $writer.Write([int]0)                       # biCompression = BI_RGB
        $writer.Write([int]($stride * $size))       # biSizeImage
        $writer.Write([int]0)                       # biXPelsPerMeter
        $writer.Write([int]0)                       # biYPelsPerMeter
        $writer.Write([int]0)                       # biClrUsed
        $writer.Write([int]0)                       # biClrImportant
        $writer.Write($xor)
        $writer.Write($mask)
        $writer.Flush()
        return $stream.ToArray()
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

# 把若干 @{ Size; Bitmap } 写成单个多尺寸 ICO
function Write-IcoFile {
    param($Frames, [string]$Path)   # Frames 必须已按尺寸升序
    $target = [System.IO.Path]::GetFullPath($Path)
    $dir = [System.IO.Path]::GetDirectoryName($target)
    if (-not [string]::IsNullOrEmpty($dir) -and -not [System.IO.Directory]::Exists($dir)) {
        [void][System.IO.Directory]::CreateDirectory($dir)
    }

    $entries = New-Object System.Collections.ArrayList
    foreach ($frame in $Frames) {
        [void]$entries.Add(@{ Size = [int]$frame.Size; Data = (Get-IconDibEntry $frame.Bitmap) })
    }
    if ($entries.Count -eq 0) { throw '没有可写入 ICO 的尺寸' }

    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    try {
        $writer.Write([int16]0)                 # reserved
        $writer.Write([int16]1)                 # type = icon
        $writer.Write([int16]$entries.Count)    # count
        $offset = 6 + 16 * $entries.Count
        foreach ($entry in $entries) {
            $size = [int]$entry.Size
            $data = [byte[]]$entry.Data
            # 宽高 256 在目录项里写 0
            if ($size -ge 256) { $writer.Write([byte]0) } else { $writer.Write([byte]$size) }
            if ($size -ge 256) { $writer.Write([byte]0) } else { $writer.Write([byte]$size) }
            $writer.Write([byte]0)              # 调色板颜色数
            $writer.Write([byte]0)              # 保留
            $writer.Write([int16]1)             # planes
            $writer.Write([int16]32)            # bitCount
            $writer.Write([int]$data.Length)    # bytesInRes
            $writer.Write([int]$offset)         # 图像数据偏移
            $offset = $offset + $data.Length
        }
        foreach ($entry in $entries) { $writer.Write([byte[]]$entry.Data) }
        $writer.Flush()
        [System.IO.File]::WriteAllBytes($target, $stream.ToArray())
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

# ============================ 主流程 ============================

# 解析 -Sizes 字符串：按逗号/分号/空白拆分，过滤非法与非正数、去重、升序。
# 全部非法时抛错（调用方要知道自己传错了，而不是拿到空结果）。
function ConvertTo-SizeList {
    param([string]$Spec)
    $default = @(16, 20, 24, 32, 40, 48, 64)
    if ([string]::IsNullOrWhiteSpace($Spec)) { return $default }

    $parsed = New-Object System.Collections.ArrayList
    foreach ($token in [regex]::Split($Spec, '[,;\s]+')) {
        $text = $token.Trim()
        if ($text.Length -eq 0) { continue }
        $value = 0
        if (-not [int]::TryParse($text, [ref]$value)) { continue }   # 非整数 → 过滤
        if ($value -le 0 -or $value -lt 8 -or $value -gt 512) { continue }   # 非正数/超范围 → 过滤
        if ($parsed -notcontains $value) { [void]$parsed.Add($value) }
    }
    if ($parsed.Count -eq 0) { throw ('-Sizes 里没有任何可用尺寸：' + $Spec) }
    return @($parsed | Sort-Object)
}

# 判断小尺寸下「挖空带」是否退化成硬边：
#   比较 badge 与 none 两版的 alpha，统计被挖掉的像素里有多少是完全透明的（=硬切）。
#   返回 $true 表示挖空带已经无法表达过渡（>80% 是硬 0），此时应放弃挖空。
function Test-CutoutDegenerated {
    param([System.Drawing.Image]$BaseImage, [string]$BadgeName, [int]$Size)

    $withBadge = $null
    $baseOnly = $null
    try {
        $withBadge = New-ComposedBitmap -BaseImage $BaseImage -BadgeName $BadgeName -Size $Size -Cutout $true
        $baseOnly = New-ComposedBitmap -BaseImage $BaseImage -BadgeName 'none' -Size $Size -Cutout $true

        $punched = 0
        $hardZero = 0
        for ($y = 0; $y -lt $Size; $y++) {
            for ($x = 0; $x -lt $Size; $x++) {
                $baseAlpha = $baseOnly.GetPixel($x, $y).A
                if ($baseAlpha -le 8) { continue }
                $badgeAlpha = $withBadge.GetPixel($x, $y).A
                if ($badgeAlpha -ge $baseAlpha) { continue }
                $punched++
                if ($badgeAlpha -eq 0) { $hardZero++ }
            }
        }
        if ($punched -le 0) { return $false }
        $hardRatio = [double]$hardZero / [double]$punched
        return ($hardRatio -gt 0.8)
    }
    finally {
        if ($null -ne $withBadge) { try { $withBadge.Dispose() } catch { } }
        if ($null -ne $baseOnly) { try { $baseOnly.Dispose() } catch { } }
    }
}

function Invoke-IconCompose {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop

    if (-not (Test-Path -LiteralPath $Base -PathType Leaf)) {
        throw "底图不存在：$Base"
    }

    $requested = @(ConvertTo-SizeList $Sizes)

    if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $OutDir -Force)
    }
    $outFull = [System.IO.Path]::GetFullPath($OutDir)
    if (-not (Test-Path -LiteralPath $outFull -PathType Container)) {
        throw "无法创建输出目录：$outFull"
    }

    $baseImage = $null
    try {
        $baseImage = Read-BaseImage ([System.IO.Path]::GetFullPath($Base))

        $icoFrames = New-Object System.Collections.ArrayList
        foreach ($size in $requested) {
            # 小尺寸兜底：挖空带在小画面上可能退化成「硬切的 1px 灰圈」。
            # 判断方法（观感修正，不属于任何外部契约）：按挖空渲染一版，与「无角标」版逐像素比 alpha，
            # 若被挖掉的像素里「纯 0」占比 > 80%，说明这条带在这个尺寸上表达不出过渡，
            # 就干脆不挖空，让角标直接压在底图上（角标自带深色描边）。
            $cutout = $true
            if ($Size -le 20 -and $Badge -ne 'none') {
                $cutout = -not (Test-CutoutDegenerated -BaseImage $baseImage -BadgeName $Badge -Size $size)
            }

            $bitmap = $null
            try {
                $bitmap = New-ComposedBitmap -BaseImage $baseImage -BadgeName $Badge -Size $size -Cutout $cutout
                $target = Join-Path $outFull ("icon-{0}.png" -f $size)
                $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
                if (-not [string]::IsNullOrWhiteSpace($OutIco)) {
                    [void]$icoFrames.Add(@{ Size = $size; Bitmap = $bitmap })
                }
            }
            finally {
                # 需要写 ICO 时位图要留到打包之后，由下面的循环统一释放
                if ([string]::IsNullOrWhiteSpace($OutIco) -and $null -ne $bitmap) {
                    try { $bitmap.Dispose() } catch { }
                }
            }
        }

        if (-not [string]::IsNullOrWhiteSpace($OutIco)) {
            try {
                Write-IcoFile $icoFrames $OutIco
            }
            finally {
                foreach ($frame in $icoFrames) {
                    try { $frame.Bitmap.Dispose() } catch { }
                }
            }
        }
    }
    finally {
        if ($null -ne $baseImage) { try { $baseImage.Dispose() } catch { } }
    }

    $json = '{"sizes":[' + ($requested -join ',') + ']}'
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

try {
    Invoke-IconCompose
}
catch {
    $message = $_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($message)) { $message = ($_.Exception.GetType().FullName) }
    [Console]::Error.WriteLine('[icon-compose] 合成失败：' + $message)
    exit 1
}

exit 0
