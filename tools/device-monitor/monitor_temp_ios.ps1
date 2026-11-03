<#
.SYNOPSIS
    iOS 温度监控（对标 Android 的 monitor_temp.bat）

.DESCRIPTION
    Android 有 adb，可以 dumpsys battery 直接拿电池温度；
    iOS 没有 adb，也没有公开 API 能读电池/CPU 温度。
    免越狱环境下最接近的做法：用 libimobiledevice 的 idevicediagnostics
    读取 IORegistry / 诊断通道里的温度字段（BatteryTemperature 等）。

    本脚本自动尝试多个入口，命中后固定使用，输出 Time,Temperature 的 CSV，
    与 plot_temp.py 完全兼容。

    前提：
      1. 已安装 Apple 移动设备支持（iTunes 或 Apple Devices，提供 usbmuxd 驱动）
      2. 已安装 libimobiledevice for Windows，idevicediagnostics.exe 在 PATH，
         或放在本目录 tools\ 下
      3. iPhone 用数据线连电脑，手机点“信任此电脑”，并保持解锁

.EXAMPLE
    .\monitor_temp_ios.ps1

.EXAMPLE
    .\monitor_temp_ios.ps1 -Interval 2 -Csv D:\logs\ios.csv -Fresh

.EXAMPLE
    .\monitor_temp_ios.ps1 -Diag
#>

[CmdletBinding()]
param(
    [int]$Interval = 5,
    [string]$Csv = '',
    [int]$MaxSamples = 0,
    [switch]$Fresh,
    [switch]$Diag,
    [switch]$Deep,
    [switch]$Raw,
    [switch]$Mock,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Continue'
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
if (-not $Csv) { $Csv = Join-Path $Root 'temp_log_ios.csv' }
$script:ActiveProbe = $null


# ============================================================
#  基础工具
# ============================================================

function Invoke-Exe {
    param(
        [string]$Exe,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 20
    )
    if (-not $Exe) { return $null }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $quoted = @()
    foreach ($a in $Arguments) {
        if ($a -match '[\s"]') { $quoted += ('"' + ($a -replace '"', '\"') + '"') }
        else { $quoted += $a }
    }
    $psi.Arguments = ($quoted -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    try {
        [void]$proc.Start()
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
            try { $proc.Kill() } catch { }
            return $null
        }
        $text = $outTask.Result + $errTask.Result
        if ($null -eq $text) { return '' }
        return $text
    }
    catch { return $null }
    finally { $proc.Dispose() }
}


function Get-IdeviExe {
    $cmd = Get-Command idevicediagnostics -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @((Join-Path $Root 'tools\idevicediagnostics.exe'), (Join-Path $Root 'idevicediagnostics.exe'))) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}


function Get-IosInfo {
    $cmd = Get-Command ideviceinfo -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    $parts = @()
    foreach ($k in @('DeviceName', 'ProductType', 'ProductVersion')) {
        $v = Invoke-Exe -Exe $cmd.Source -Arguments @('-k', $k) -TimeoutSec 12
        if ($v) {
            $line = $v -split '\r?\n' | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
            if ($line) { $parts += $line.Trim() }
        }
    }
    if ($parts.Count -eq 0) { return $null }
    return ($parts -join ' / ')
}


# ============================================================
#  温度解析
# ============================================================

# 把原始数字换算成摄氏度。iOS 里常见三种量纲：
#   31.2  -> 已经是摄氏度
#   312   -> 十分之一度（deci-degree）
#   3120  -> 百分之一度
# 取第一个落在 5~120 度区间的结果。
function ConvertTo-Celsius {
    param([double]$Value)
    foreach ($d in @(1, 10, 100)) {
        $t = $Value / $d
        if ($t -ge 5 -and $t -le 120) { return [math]::Round($t, 1) }
    }
    return $null
}


# 从 ioreg / plist 文本里找温度字段。
# 同时兼容三种写法：
#   <key>BatteryTemperature</key><integer>312</integer>
#   "BatteryTemperature" = 312
#   "GasGaugeTemperature" = 28.5
function Get-TemperatureFromText {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }

    $pattern = '(?is)(?<key>[A-Za-z0-9_]*[Tt]emperature[A-Za-z0-9_]*)["'']?\s*(?:</key>)?\s*(?:[=:]\s*)?(?:<(?:integer|real|string)>\s*)?(?<val>-?\d+(?:\.\d+)?)'

    $best = $null
    $bestScore = -1
    foreach ($m in [regex]::Matches($Text, $pattern)) {
        $key = $m.Groups['key'].Value
        $val = 0.0
        $ok = [double]::TryParse(
            $m.Groups['val'].Value,
            [System.Globalization.NumberStyles]::Float,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [ref]$val)
        if (-not $ok) { continue }

        $c = ConvertTo-Celsius -Value $val
        if ($null -eq $c) { continue }

        $score = 1
        if ($key -match '(?i)gasgauge') { $score = 40 }
        elseif ($key -match '(?i)^BatteryTemperature$') { $score = 30 }
        elseif ($key -match '(?i)battery') { $score = 25 }
        elseif ($key -match '(?i)^Temperature$') { $score = 10 }
        elseif ($key -match '(?i)temperature') { $score = 5 }

        if ($score -gt $bestScore) { $bestScore = $score; $best = $c }
    }
    return $best
}


# ============================================================
#  Python 桥接（pymobiledevice3，免装 exe 的方案）
# ============================================================

function Get-PythonExe {
    foreach ($n in @('python', 'py')) {
        $c = Get-Command $n -ErrorAction SilentlyContinue
        if ($c) { return $c.Source }
    }
    return $null
}

function Test-PythonBridge {
    $bridge = Join-Path $Root 'ios_temp_reader.py'
    if (-not (Test-Path -LiteralPath $bridge)) { return $false }
    $py = Get-PythonExe
    if (-not $py) { return $false }
    $r = Invoke-Exe -Exe $py -Arguments @('-c', 'import pymobiledevice3') -TimeoutSec 40
    return ($null -ne $r -and $r.Trim() -eq '')
}

function Get-IosInfoFromBridge {
    $py = Get-PythonExe
    $bridge = Join-Path $Root 'ios_temp_reader.py'
    if (-not $py -or -not (Test-Path -LiteralPath $bridge)) { return $null }
    $out = Invoke-Exe -Exe $py -Arguments @($bridge, '--json') -TimeoutSec 120
    if (-not $out) { return $null }
    foreach ($line in ($out -split '?
')) {
        $line = $line.Trim()
        if (-not $line.StartsWith('{')) { continue }
        try { $j = $line | ConvertFrom-Json } catch { continue }
        if ($j.device) { return ($j.device.type + ' / iOS ' + $j.device.version) }
        return $null
    }
    return $null
}

function Read-IosTemperaturePython {
    param([switch]$IncludeDeep)

    $bridge = Join-Path $Root 'ios_temp_reader.py'
    $py = Get-PythonExe
    if (-not (Test-Path -LiteralPath $bridge) -or -not $py) { return $null }

    $a = @($bridge, '--json')
    if ($IncludeDeep) { $a += '--deep' }
    $out = Invoke-Exe -Exe $py -Arguments $a -TimeoutSec 120
    if (-not $out) { return $null }

    $json = $null
    foreach ($line in ($out -split '?
')) {
        $line = $line.Trim()
        if ($line.StartsWith('{')) {
            try { $json = $line | ConvertFrom-Json } catch { }
            if ($json) { break }
        }
    }
    if ($json -and $json.ok -and $null -ne $json.temp) {
        $script:ActiveProbe = 'pymobiledevice3:' + $json.source
        if ($Raw) { Write-Host $out.Trim() -ForegroundColor DarkGray }
        return [double]$json.temp
    }
    return $null
}


# ============================================================
#  采集入口（按成功率排序，命中后固定）
# ============================================================

function Get-ProbeList {
    param([switch]$IncludeDeep)
    $probes = @(
        [pscustomobject]@{ Name = 'ioregentry AppleARMPMUCharger'; Args = @('ioregentry', 'AppleARMPMUCharger') },
        [pscustomobject]@{ Name = 'diagnostics GasGauge';           Args = @('diagnostics', 'GasGauge') },
        [pscustomobject]@{ Name = 'ioregentry AppleSMC';            Args = @('ioregentry', 'AppleSMC') },
        [pscustomobject]@{ Name = 'ioregentry IOPMPowerSource';     Args = @('ioregentry', 'IOPMPowerSource') }
    )
    if ($IncludeDeep) {
        $probes += [pscustomobject]@{ Name = 'diagnostics Power'; Args = @('diagnostics', 'Power') }
        $probes += [pscustomobject]@{ Name = 'diagnostics All';   Args = @('diagnostics', 'All') }
    }
    return $probes
}


function Read-IosTemperature {
    param([switch]$IncludeDeep)

    $exe = Get-IdeviExe
    if (-not $exe) { return Read-IosTemperaturePython -IncludeDeep:$IncludeDeep }

    $probes = @(Get-ProbeList -IncludeDeep:$IncludeDeep)
    if ($script:ActiveProbe) {
        $first = @($probes | Where-Object { $_.Name -eq $script:ActiveProbe })
        $rest = @($probes | Where-Object { $_.Name -ne $script:ActiveProbe })
        $probes = @($first + $rest)
    }

    foreach ($probe in $probes) {
        $text = Invoke-Exe -Exe $exe -Arguments $probe.Args -TimeoutSec 20
        if (-not $text) { continue }
        $t = Get-TemperatureFromText -Text $text
        if ($null -ne $t) {
            $script:ActiveProbe = $probe.Name
            if ($Raw) {
                Write-Host ('--- ' + $probe.Name + ' ---') -ForegroundColor DarkGray
                Write-Host $text -ForegroundColor DarkGray
            }
            return $t
        }
    }

    # idevicediagnostics 装了但读不到（例如 iOS 26 上 IORegistry 被收紧），退回 python 桥接
    if ($script:BridgeOk) { return Read-IosTemperaturePython -IncludeDeep:$IncludeDeep }
    return $null
}


function Write-Sample {
    param([string]$Time, [double]$Temp)
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $line = '{0},{1}' -f $Time, $Temp.ToString('0.0', $inv)
    Add-Content -LiteralPath $Csv -Value $line -Encoding ascii
}


# ============================================================
#  诊断模式
# ============================================================

function Invoke-Diag {
    $exe = Get-IdeviExe

    # 没有 idevicediagnostics 时改用 python 桥接做诊断
    if (-not $exe) {
        $py = Get-PythonExe
        $bridge = Join-Path $Root 'ios_temp_reader.py'
        if ($py -and (Test-Path -LiteralPath $bridge)) {
            $out = Invoke-Exe -Exe $py -Arguments @($bridge, '--diag') -TimeoutSec 240
            $file = Join-Path $Root 'ios_diag.txt'
            Set-Content -LiteralPath $file -Value $out -Encoding UTF8
            if ($out) { Write-Host $out }
            Write-Host ('诊断报告已保存: ' + $file) -ForegroundColor Cyan
            return
        }
        Write-Host '既没有 idevicediagnostics，也没有可用的 python 桥接，无法诊断。' -ForegroundColor Red
        return
    }

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('==== iOS 温度读取诊断 ====')
    [void]$sb.AppendLine('时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

    $info = Get-IosInfo
    if ($info) { [void]$sb.AppendLine('设备: ' + $info) }
    else { [void]$sb.AppendLine('设备: 未取到设备信息（未连接 / 未信任 / 缺 ideviceinfo.exe）') }

    $cands = @(Get-ProbeList -IncludeDeep)
    $cands += [pscustomobject]@{ Name = 'ioregistry IOService'; Args = @('ioregistry', 'IOService') }

    $allHits = @()
    foreach ($probe in $cands) {
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('===== ' + $probe.Name + ' =====')
        $text = Invoke-Exe -Exe $exe -Arguments $probe.Args -TimeoutSec 90

        if (-not $text) {
            [void]$sb.AppendLine('(无输出 / 超时 / 该命令不存在)')
            Write-Host ('  [空] ' + $probe.Name) -ForegroundColor DarkGray
            continue
        }

        $t = Get-TemperatureFromText -Text $text
        if ($null -eq $t) { [void]$sb.AppendLine('解析结果: 未找到可用温度字段') ; Write-Host ('  [未命中] ' + $probe.Name) -ForegroundColor Yellow }
        else { [void]$sb.AppendLine('解析结果: ' + $t.ToString('0.0') + ' C'); Write-Host ('  [命中] ' + $probe.Name + ' -> ' + $t.ToString('0.0') + ' C') -ForegroundColor Green }

        $lines = @($text -split '\r?\n' | Where-Object { $_ -match '(?i)temperature' } | Select-Object -First 60)
        if ($lines.Count -gt 0) {
            [void]$sb.AppendLine('--- 含 Temperature 的原始行 ---')
            foreach ($l in $lines) {
                [void]$sb.AppendLine($l.Trim())
                $allHits += ($probe.Name + ' | ' + $l.Trim())
            }
        }

        # 原始内容只对体量小的入口入档，避免文件过大
        if ($probe.Name -ne 'ioregistry IOService') {
            $rawLines = @($text -split '\r?\n' | Select-Object -First 400)
            [void]$sb.AppendLine('--- 原始输出（截断 400 行）---')
            foreach ($l in $rawLines) { [void]$sb.AppendLine($l) }
        }
    }

    $outFile = Join-Path $Root 'ios_diag.txt'
    Set-Content -LiteralPath $outFile -Value $sb.ToString() -Encoding UTF8

    Write-Host ''
    Write-Host ('诊断报告已保存: ' + $outFile) -ForegroundColor Cyan
    if ($allHits.Count -eq 0) {
        Write-Host '没有发现任何 Temperature 字段。可能原因：' -ForegroundColor Yellow
        Write-Host '  1) 手机未解锁 / 未点“信任此电脑”'
        Write-Host '  2) iOS 版本过高，诊断通道需要开发者模式或已被限制'
        Write-Host '  3) 需要更高权限（越狱设备才能直接读 IOKit）'
    }
}


# ============================================================
#  自测（不需要设备）
# ============================================================

function Invoke-SelfTest {
    $script:stPass = 0
    $script:stFail = 0

    $cases = @(
        [pscustomobject]@{ Name = 'plist 十分之一度'; Text = '<key>BatteryTemperature</key><integer>312</integer>'; Expect = 31.2 },
        [pscustomobject]@{ Name = 'ioreg 文本形式';   Text = '"BatteryTemperature" = 345';                               Expect = 34.5 },
        [pscustomobject]@{ Name = 'GasGauge 小数';    Text = '"GasGaugeTemperature" = 28.5';                            Expect = 28.5 },
        [pscustomobject]@{ Name = '已是摄氏度';       Text = '"Temperature" = 41';                                     Expect = 41.0 },
        [pscustomobject]@{ Name = '百分之一度';       Text = '<key>Temperature</key><real>3120</real>';                  Expect = 31.2 },
        [pscustomobject]@{ Name = '优先电池字段';     Text = ([string]::Join([Environment]::NewLine, @('"Temperature" = 55', '"BatteryTemperature" = 331'))); Expect = 33.1 },
        [pscustomobject]@{ Name = '越界值丢弃';       Text = '"Temperature" = 99999';                                   Expect = $null },
        [pscustomobject]@{ Name = '空输入';           Text = '';                                                          Expect = $null }
    )

    Write-Host '温度解析测试' -ForegroundColor Cyan
    foreach ($c in $cases) {
        $got = Get-TemperatureFromText -Text $c.Text
        $ok = $false
        if ($null -eq $c.Expect) { $ok = ($null -eq $got) }
        elseif ($null -ne $got) { $ok = ([math]::Abs([double]$got - [double]$c.Expect) -lt 0.05) }

        if ($ok) {
            $script:stPass++
            $shown = if ($null -eq $got) { '(无)' } else { $got.ToString('0.0') + ' C' }
            Write-Host ('  [PASS] ' + $c.Name + ' -> ' + $shown) -ForegroundColor Green
        } else {
            $script:stFail++
            Write-Host ('  [FAIL] ' + $c.Name + '  期望 ' + $c.Expect + '，实际 ' + $got) -ForegroundColor Red
        }
    }

    Write-Host ''
    Write-Host 'CSV 输出格式测试' -ForegroundColor Cyan
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('ios_selftest_' + [guid]::NewGuid().ToString('N') + '.csv')
    $old = $Csv
    $Csv = $tmp
    Set-Content -LiteralPath $Csv -Value 'Time,Temperature' -Encoding ascii
    foreach ($row in @(@('09:00:01', 31.2), @('09:00:06', 31.8), @('09:00:11', 32.5))) {
        Write-Sample -Time $row[0] -Temp $row[1]
    }
    $lines = @(Get-Content -LiteralPath $Csv)
    $okHead = ($lines.Count -eq 4 -and $lines[0].Trim() -eq 'Time,Temperature')
    $okRows = $true
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -notmatch '^\d{2}:\d{2}:\d{2},-?\d+\.\d$') { $okRows = $false }
    }

    if ($okHead -and $okRows) {
        $script:stPass++
        Write-Host ('  [PASS] 4 行、表头 Time,Temperature、数值格式可被 plot_temp.py 解析') -ForegroundColor Green
    } else {
        $script:stFail++
        Write-Host '  [FAIL] CSV 格式不符' -ForegroundColor Red
        $lines | ForEach-Object { Write-Host ('    ' + $_) }
    }

    Remove-Item -LiteralPath $Csv -Force -ErrorAction SilentlyContinue
    $Csv = $old

    Write-Host ''
    Write-Host ('自测结果: 通过 ' + $script:stPass + ' 项，失败 ' + $script:stFail + ' 项') -ForegroundColor Cyan
    if ($script:stFail -eq 0) { return 0 }
    return 1
}


# ============================================================
#  入口
# ============================================================

if ($SelfTest) { exit (Invoke-SelfTest) }

$exe = Get-IdeviExe
$bridgeOk = Test-PythonBridge
$script:BridgeOk = $bridgeOk
if (-not $exe -and -not $bridgeOk -and -not $Mock) {
    Write-Host ''
    Write-Host '[x] 没有可用的 iOS 读取通道。' -ForegroundColor Red
    Write-Host ''
    Write-Host '按顺序处理：' -ForegroundColor Yellow
    Write-Host '  1) 装 Apple 驱动（usbmuxd）：winget install Apple.AppleMobileDeviceSupport'
    Write-Host '  2) 二选一：'
    Write-Host '       A. python -m pip install pymobiledevice3   （配合本目录的 ios_temp_reader.py，免 exe）'
    Write-Host '       B. 装 libimobiledevice，把 idevicediagnostics.exe 放进 PATH 或本目录 tools\'
    Write-Host '  3) 手机插线、解锁，并点“信任此电脑”'
    Write-Host ''
    Write-Host '装好后先跑: .\monitor_temp_ios.ps1 -Diag'
    Write-Host ''
    exit 2
}

Write-Host ''
Write-Host '=== iOS 温度监控 ===' -ForegroundColor Cyan
$info = Get-IosInfo
if (-not $info -and $bridgeOk) { $info = Get-IosInfoFromBridge }
if ($info) { Write-Host ('设备   : ' + $info) }
else { Write-Host '设备   : 未识别（检查数据线 / 是否点了“信任此电脑”）' -ForegroundColor Yellow }

if ($Diag) {
    Write-Host '模式   : 诊断'
    Write-Host ''
    Invoke-Diag
    exit 0
}

Write-Host ('间隔   : ' + $Interval + ' 秒')
Write-Host ('输出   : ' + $Csv)
$backendName = if ($exe) { 'idevicediagnostics（自动尝试多个 IORegistry 入口）' } else { 'pymobiledevice3 diagnostics relay' }
Write-Host ('方式   : ' + $backendName)
Write-Host ''

$csvDir = Split-Path -Parent $Csv
if ($csvDir -and -not (Test-Path -LiteralPath $csvDir)) {
    New-Item -ItemType Directory -Path $csvDir -Force | Out-Null
}
if ($Fresh -or -not (Test-Path -LiteralPath $Csv)) {
    Set-Content -LiteralPath $Csv -Value 'Time,Temperature' -Encoding ascii
}

$temps = New-Object System.Collections.ArrayList
$samples = 0
$fails = 0
$started = Get-Date
$mockTemp = 31.0

try {
    while ($true) {
        if ($Mock) {
            $mockTemp = [math]::Round($mockTemp + (Get-Random -Minimum -3 -Maximum 30) / 10.0, 1)
            $t = $mockTemp
            $script:ActiveProbe = 'Mock'
        }
        else {
            $t = Read-IosTemperature -IncludeDeep:$Deep
        }

        if ($null -eq $t) {
            $fails++
            Write-Host ('[{0}] 读取失败（连续 {1} 次）' -f (Get-Date -Format 'HH:mm:ss'), $fails) -ForegroundColor Yellow
            if ($fails -eq 3) {
                Write-Host '  提示: 手机需解锁并已点“信任此电脑”；若一直读不到，先运行: .\monitor_temp_ios.ps1 -Diag' -ForegroundColor DarkYellow
            }
            if ($fails -ge 10) {
                Write-Host '连续失败 10 次，退出。请先用 -Diag 定位原因。' -ForegroundColor Red
                break
            }
        }
        else {
            $fails = 0
            $now = Get-Date -Format 'HH:mm:ss'
            Write-Sample -Time $now -Temp $t
            [void]$temps.Add($t)
            $samples++
            Write-Host ('{0}  {1,5:0.0} C   [{2}]' -f $now, $t, $script:ActiveProbe)
        }

        if ($MaxSamples -gt 0 -and $samples -ge $MaxSamples) { break }
        if ($Interval -gt 0) { Start-Sleep -Seconds $Interval }
    }
}
finally {
    Write-Host ''
    Write-Host '=== 结束 ===' -ForegroundColor Cyan
    if ($samples -gt 0) {
        $stat = $temps | Measure-Object -Minimum -Maximum -Average
        $secs = ((Get-Date) - $started).TotalSeconds
        Write-Host ('样本 {0} 个，时长 {1:N0} 秒' -f $samples, $secs)
        Write-Host ('最低 {0:0.0} C   最高 {1:0.0} C   平均 {2:0.0} C' -f $stat.Minimum, $stat.Maximum, $stat.Average)
    }
    Write-Host ('CSV: ' + $Csv)
    Write-Host '画图: 把 plot_temp.py 里的 CSV_FILE 改成上面这个路径，再 python plot_temp.py'
}
