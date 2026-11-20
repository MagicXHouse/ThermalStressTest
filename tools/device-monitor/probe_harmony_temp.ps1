# 探测鸿蒙 NEXT（HarmonyOS 5/6/7+）的温度与取数通道 —— 用 hdc
#
# 已在华为 Mate 60（设备上报 BRA-AL00 / HarmonyOS 7.0.0 / API 26）实机验证：
#   ✅ 温度：hidumper 两条路都通（BatteryService / ThermalService）
#   ❌ sysfs：/sys/class/thermal 被 SELinux 挡住（Permission denied）
#   ❌ 沙箱：/data/app/el2、/data/storage/el2 都不给 shell 读 → hdc 拉不到小游戏 CSV
#
# 用法（手机开好「USB 调试」并授权后）：
#   .\探测温度通道_hdc.ps1
#   .\探测温度通道_hdc.ps1 -HdcPath "D:\...\toolchains\hdc.exe"

param(
    [string]$HdcPath = ''
)

$ErrorActionPreference = 'Continue'
$sep = ('-' * 72)

function Find-Hdc {
    param([string]$explicit)
    if ($explicit -and (Test-Path $explicit)) { return (Resolve-Path $explicit).Path }
    $cmd = Get-Command hdc -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @("D:\commandline-tools-windows-x64-26.0.0.865\command-line-tools\sdk\default\openharmony\toolchains\hdc.exe",
                     "$env:LOCALAPPDATA\Huawei\Sdk\*\toolchains\hdc.exe",
                     "C:\Program Files\Huawei\DevEco Studio\sdk\*\toolchains\hdc.exe")) {
        $hit = Get-ChildItem -Path $c -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$hdc = Find-Hdc -explicit $HdcPath
Write-Host $sep
Write-Host ("hdc: " + $(if ($hdc) { $hdc } else { '找不到' }))
if (-not $hdc) {
    Write-Host "装华为 Command Line Tools，找 sdk\...\toolchains\hdc.exe，加 PATH 或用 -HdcPath 指定"
    exit 1
}
Write-Host ("版本: " + ((& $hdc version 2>&1) -join ' '))
$targets = (& $hdc list targets 2>&1) | Where-Object { $_ -and $_ -notmatch 'Empty|Unauthorized' }
Write-Host ("设备: " + $(if ($targets) { $targets -join ', ' } else { '无 / 未授权' }))
Write-Host $sep
if (-not $targets) {
    Write-Host "没有可用设备：手机解锁 → 弹窗「允许调试」→ 勾始终允许；不行就「撤销 USB 调试授权」再插线"
    exit 1
}

function Run-Hdc([string]$cmd) { (& $hdc shell $cmd 2>&1) -join "`n" }

# ---------- 设备信息 ----------
Write-Host "`n[1] 设备信息"
foreach ($p in 'const.product.model', 'const.product.brand', 'const.product.os.dist.version', 'const.ohos.apiversion', 'const.product.software.version') {
    $v = (Run-Hdc "param get $p").Trim()
    Write-Host ("    " + $p.PadRight(34) + " = " + $v)
}

# ---------- 温度 1：BatteryService ----------
Write-Host "`n[2] 温度通道 A：hidumper -s BatteryService -a '-i'   ← 与 Android 电池温度同口径"
$batOk = $false
$batOut = Run-Hdc "hidumper -s BatteryService -a '-i' 2>&1"
$m = [regex]::Match($batOut, 'temperature:\s*(-?\d+)')
if ($m.Success) {
    Write-Host ("    ✅ temperature = " + $m.Groups[1].Value + "  →  " + ([double]$m.Groups[1].Value / 10).ToString('0.0') + " ℃（单位 0.1℃）")
    Write-Host ("    capacity: " + ([regex]::Match($batOut, 'capacity:\s*(\d+)').Groups[1].Value) + "   chargingStatus: " + ([regex]::Match($batOut, 'chargingStatus:\s*(\d+)').Groups[1].Value) + "   pluggedType: " + ([regex]::Match($batOut, 'pluggedType:\s*(\d+)').Groups[1].Value))
    $batOk = $true
} else {
    Write-Host "    ❌ 读不到 temperature 字段"
}

# ---------- 温度 2：ThermalService ----------
Write-Host "`n[3] 温度通道 B：hidumper -s ThermalService -a '-t'   ← 多传感器（机身/SoC）"
$thOut = Run-Hdc "hidumper -s ThermalService -a '-t' 2>&1"
$zones = @{}
$cur = $null
foreach ($ln in ($thOut -split "`n")) {
    $t = $ln.Trim()
    if ($t -match '^Type:\s*(\S+)') { $cur = $matches[1] }
    elseif ($t -match '^Temperature:\s*(-?\d+)' -and $cur) {
        $zones[$cur] = [double]$matches[1] / 1000.0
        $cur = $null
    }
}
if ($zones.Count) {
    Write-Host ("    ✅ 读到 " + $zones.Count + " 个 zone（单位 0.001℃）：")
    $zones.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
        Write-Host ("       " + $_.Key.PadRight(14) + $_.Value.ToString('0.0') + " ℃")
    }
    Write-Host "    建议：主指标用 BatteryService（跨机型可比）；机身温度用 shell_back，SoC 用 system_h"
} else {
    Write-Host "    ❌ 读不到 zone 数据"
}

# ---------- sysfs（预期不通，留作记录） ----------
Write-Host "`n[4] /sys/class/thermal（预期被 SELinux 挡住）"
Write-Host ("    " + (Run-Hdc "cat /sys/class/thermal/thermal_zone0/temp 2>&1").Trim())

# ---------- 取数通道 ----------
Write-Host "`n[5] 取数：能不能读微信沙箱"
$denied = 0
foreach ($p in '/data/app/el2/100/base', '/data/storage/el2/base', '/storage/media/100/local/files') {
    $r = Run-Hdc ("ls " + $p + " 2>&1").Trim()
    $ok = ($r -notmatch 'Permission denied|No such file')
    Write-Host ("    " + $p.PadRight(34) + $(if ($ok) { '✅ 可读' } else { '❌ ' + (($r -split "`n")[0]) }))
    if (-not $ok) { $denied++ }
}
$found = (Run-Hdc "find /storage /data/storage -maxdepth 5 -name 'thermal_*' 2>/dev/null | head -10").Trim()
if ($found) {
    Write-Host "    ✅ 找到 CSV："; ($found -split "`n") | ForEach-Object { Write-Host ("       " + $_.Trim()) }
} else {
    Write-Host "    ⚠️ 没找到 thermal_*.csv（也可能是游戏还没在这台机器上跑过）"
}

# ---------- 结论 ----------
Write-Host "`n" $sep
Write-Host "结论"
Write-Host $sep
Write-Host ("  温度: " + $(if ($batOk) { '✅ 用 monitor_temp_harmony.ps1（默认 BatteryService，同 Android 口径）' }
                        elseif ($zones.Count) { '⚠️ 只能用 ThermalService 的某个 zone（口径不同，需注明）' }
                        else { '❌ 都不通 → 人工点测' }))
if ($denied -ge 2) {
    Write-Host "  取数: ❌ hdc 读不到应用沙箱 → CSV 拉不出来，改用分页复制："
    Write-Host "        s('csvpages') 看总页数 → s('copypage:1') / 2 / 3 …，每页 120 行"
    Write-Host "        粘到微信「文件传输助手」或备忘录，再传到 PC 拼起来"
} elseif ($found) {
    Write-Host "  取数: ✅ hdc file recv 拉 CSV"
} else {
    Write-Host "  取数: ⚠️ 沙箱不可读但也没找到文件 —— 先跑一次游戏导出再复查"
}
Write-Host ""
