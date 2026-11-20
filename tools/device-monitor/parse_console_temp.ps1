# 从 PowerShell 控制台的文本回滚里，把温度采样还原成 CSV
#
# 为什么需要它：鸿蒙 NEXT 上应用沙箱不可读、hdc 拿不到文件，唯一可靠的"兜底副本"
# 就是采集脚本打到控制台的那一行行输出（每个采样点打印 `# 12  16:24:10.82  33.0 ℃`）。
# 文件被误删/覆盖时，把窗口内容全选复制粘贴成文本，用本脚本还原。
#
# 用法：
#   .\parse_console_temp.ps1 -In console.txt -Out gbr_temp.csv
#   .\parse_console_temp.ps1 -In console.txt -Out gbr_temp.csv -Since 16:14:00 -Until 16:50:00
#   .\parse_console_temp.ps1 -In console.txt -Out gbr_temp.csv -Merge 已有的部分.csv
#
# -Merge：把已有 CSV（Time,Temperature）里的行也并进来，按时间戳去重后排序，
#         用于"前半段从控制台恢复 + 后半段从文件里拿"的拼接。
param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Since = '',
    [string]$Until = '',
    [string]$Merge = ''
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $In)) { Write-Error "找不到输入文件: $In"; exit 1 }

$rows = @{}

# 1) 解析控制台行：  #  12  16:24:10.82  33.0 ℃
$text = Get-Content $In -Encoding utf8
$re = [regex]'#\s*\d+\s+(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*(?:℃|C)?'
$n = 0
foreach ($line in $text) {
    $m = $re.Match($line)
    if ($m.Success) {
        $ts = [datetime]::Parse($m.Groups[1].Value)
        $rows[$ts.ToString('HH:mm:ss.ff')] = [double]$m.Groups[2].Value
        $n++
    }
}
Write-Host ("从控制台文本解析出 " + $n + " 个采样点（去重后 " + $rows.Count + " 个）")

# 2) 并入已有 CSV
if ($Merge) {
    if (-not (Test-Path $Merge)) { Write-Warning "找不到 -Merge 文件: $Merge" }
    else {
        $m2 = 0
        foreach ($line in (Get-Content $Merge -Encoding utf8 | Select-Object -Skip 1)) {
            $p = $line.Split(',')
            if ($p.Count -ge 2 -and $p[1] -match '^-?\d+(\.\d+)?$') {
                $ts = [datetime]::Parse($p[0])
                $key = $ts.ToString('HH:mm:ss.ff')
                if (-not $rows.ContainsKey($key)) { $rows[$key] = [double]$p[1]; $m2++ }
            }
        }
        Write-Host ("从 " + (Split-Path $Merge -Leaf) + " 并入 " + $m2 + " 个新采样点")
    }
}

# 3) 时间窗裁剪
$keys = $rows.Keys | Sort-Object { [datetime]::Parse($_) }
if ($Since) { $s = [datetime]::Parse($Since); $keys = $keys | Where-Object { [datetime]::Parse($_) -ge $s } }
if ($Until) { $u = [datetime]::Parse($Until); $keys = $keys | Where-Object { [datetime]::Parse($_) -le $u } }

if (-not $keys) { Write-Error "没有可输出的采样点（检查解析规则或时间窗）"; exit 1 }

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$lines = @('Time,Temperature')
foreach ($k in $keys) { $lines += ($k + ',' + $rows[$k].ToString('0.0')) }
[IO.File]::WriteAllLines($Out, $lines, (New-Object Text.UTF8Encoding($false)))

Write-Host ("已写出 " + $Out + "：" + ($lines.Count - 1) + " 个点")
Write-Host ("  首: " + $keys[0] + "   末: " + $keys[-1])
$v = $keys | ForEach-Object { $rows[$_] }
Write-Host ("  起始 " + $v[0] + "℃ → 结束 " + $v[-1] + "℃   ΔT +" + ([math]::Round($v[-1] - $v[0], 1)) + "℃")
