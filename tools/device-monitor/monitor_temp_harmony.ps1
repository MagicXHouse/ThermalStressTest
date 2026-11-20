# 温度采集（鸿蒙 NEXT，hdc + hidumper 版）
#
# 输出格式与 Android 版完全一致（Time,Temperature），所以 汇总实验.js / 体检单轮.js 不用改。
#
# 两个数据源（默认 battery，与其它机型的 "电池温度" 同口径，可直接跨机型比）：
#
#   battery  → hidumper -s BatteryService -a '-i'   →  temperature: 240  →  /10 = 24.0℃
#   thermal  → hidumper -s ThermalService -a '-t'   →  多传感器（Battery/ambient/charger/
#              rfboard/shell_back/shell_frame/shell_front/system_h），单位是 0.001℃
#
# 行为约定：
#   · 每次启动**先删掉旧文件**再写表头（避免两轮数据混在一个文件里）
#   · 每个采样点**同时打印到控制台**（否则双击后看起来像卡住了）
#
# 用法：
#   .\monitor_temp_harmony.ps1 -Out .\temp_log.csv -Interval 5
#   .\monitor_temp_harmony.ps1 -Out ... -Source thermal -Zone shell_back
#   .\monitor_temp_harmony.ps1 -Out ... -Quiet          # 只写文件，不打印
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$Interval = 5,
    [ValidateSet('battery', 'thermal')][string]$Source = 'battery',
    [string]$Zone = '',
    [string]$HdcPath = '',
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

function Find-Hdc {
    param([string]$explicit)
    if ($explicit -and (Test-Path $explicit)) { return (Resolve-Path $explicit).Path }
    $cmd = Get-Command hdc -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $toolRoot = 'D:\commandline-tools-windows-x64-26.0.0.865\command-line-tools'
    foreach ($c in @("$toolRoot\sdk\default\openharmony\toolchains\hdc.exe",
                     "$env:LOCALAPPDATA\Huawei\Sdk\*\toolchains\hdc.exe",
                     "C:\Program Files\Huawei\DevEco Studio\sdk\*\toolchains\hdc.exe")) {
        $hit = Get-ChildItem -Path $c -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$hdc = Find-Hdc -explicit $HdcPath
if (-not $hdc) { Write-Error "找不到 hdc.exe（用 -HdcPath 指定）"; exit 1 }
$targets = (& $hdc list targets 2>&1) | Where-Object { $_ -and $_ -notmatch 'Empty|Unauthorized' }
if (-not $targets) { Write-Error "没有可用的 hdc 设备（检查手机授权弹窗）"; exit 1 }

function Get-BatteryTemp {
    $out = ((& $hdc shell "hidumper -s BatteryService -a '-i' 2>&1") -join "`n")
    $m = [regex]::Match($out, 'temperature:\s*(-?\d+)')
    if ($m.Success) { return ([double]$m.Groups[1].Value / 10.0) }
    return $null
}

function Get-ThermalZones {
    $out = ((& $hdc shell "hidumper -s ThermalService -a '-t' 2>&1") -join "`n")
    $map = @{}
    $cur = $null
    foreach ($ln in ($out -split "`n")) {
        $t = $ln.Trim()
        if ($t -match '^Type:\s*(\S+)') { $cur = $matches[1] }
        elseif ($t -match '^Temperature:\s*(-?\d+)' -and $cur) {
            $map[$cur] = [double]$matches[1] / 1000.0
            $cur = $null
        }
    }
    return $map
}

if ($Source -eq 'thermal' -and -not $Zone) {
    $zones = Get-ThermalZones
    if (-not $zones.Count) { Write-Error "ThermalService 读不到 zone，先跑 probe_harmony_temp.ps1"; exit 1 }
    foreach ($pref in @('Battery', 'shell_back', 'system_h')) {
        if ($zones.ContainsKey($pref)) { $Zone = $pref; break }
    }
    if (-not $Zone) { $Zone = ($zones.Keys | Select-Object -First 1) }
    Write-Host ("自动选用 zone: " + $Zone + " = " + $zones[$Zone].ToString('0.0') + " ℃")
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

# 每次启动先清掉旧文件：两轮数据混在一个文件里会污染 ΔT 基线
if (Test-Path $Out) {
    try {
        Remove-Item $Out -Force -ErrorAction Stop
        if (-not $Quiet) { Write-Host ("已删除旧文件: " + $Out) }
    } catch {
        Write-Warning ("旧文件删不掉（可能被 Excel 占用），将直接覆盖: " + $_.Exception.Message)
    }
}
"Time,Temperature" | Set-Content -Path $Out -Encoding utf8

$label = if ($Source -eq 'battery') { 'BatteryService.temperature（与 Android 电池温度同口径）' } else { "ThermalService/$Zone" }
Write-Host ("开始采集 -> " + $Out)
Write-Host ("  数据源: " + $label + "，间隔 " + $Interval + "s，Ctrl+C 停止")

$na = 0
$count = 0
while ($true) {
    $temp = 'NA'
    if ($Source -eq 'battery') {
        $v = Get-BatteryTemp
        if ($null -ne $v) { $temp = $v.ToString('0.0') }
    } else {
        $z = Get-ThermalZones
        if ($z.ContainsKey($Zone)) { $temp = $z[$Zone].ToString('0.0') }
    }
    if ($temp -eq 'NA') { $na++ } else { $na = 0 }
    $ts = (Get-Date).ToString('HH:mm:ss.ff')
    ($ts + ',' + $temp) | Add-Content -Path $Out -Encoding utf8

    $count++
    if (-not $Quiet) {
        $shown = if ($temp -eq 'NA') { 'NA（读不到）' } else { $temp + ' ℃' }
        Write-Host ("  #" + $count.ToString().PadLeft(3) + "  " + $ts + "  " + $shown)
    }
    if ($na -eq 3) { Write-Warning "连续 3 次读不到温度，检查 hdc 连接与手机授权" }
    Start-Sleep -Seconds $Interval
}
