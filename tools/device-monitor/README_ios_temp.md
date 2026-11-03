# iOS 温度监控（对标 monitor_temp.bat）

## 结论先说

Android 免 root 就能读温度，是因为 adb 的 dumpsys battery 直接给了 temperature 字段。
iOS 没有 adb，苹果也没有开放任何读电池/CPU 温度的公开 API。
但免越狱也有可行办法：通过 diagnostic relay 查询电池数据，里面有摄氏温度字段。

已经在你机器上实测通过（iPhone18,3 / iOS 26.5.2）：

    diagnostics.battery -> Temperature = 3079   (单位 0.01 摄氏度 -> 30.8 C)
    diagnostics.battery -> VirtualTemperature = 2959 -> 29.6 C（备用值）

脚本自动丢弃 LifetimeData 里的历史最高/最低温度，只取当前温度。

## 文件清单

    monitor_temp_ios.bat    双击运行（推荐）
    monitor_temp_ios.ps1    主脚本：采样循环 + CSV + 统计 + 诊断 + 自测
    ios_temp_reader.py      Python 桥接：真正读设备的那一层（pymobiledevice3）
    README_ios_temp.md      本说明
    temp_log_ios.csv        运行后生成，格式 Time,Temperature

输出与 Android 脚本完全一致，plot_temp.py 不用改逻辑，只改 CSV_FILE：

    Time,Temperature
    11:18:23,30.9
    11:18:24,30.9

## 与 Android 脚本对照

    Android                              iOS
    adb shell dumpsys battery            diagnostics relay (com.apple.mobile.diagnostics_relay)
      -> temperature: 336                  -> get_battery()["Temperature"] = 3079
    免 root、一条命令                     需要电脑 + 数据线 + 解锁并信任

## 环境（本机已装好）

    Apple Mobile Device Support 19.4.0.10   winget install Apple.AppleMobileDeviceSupport
    pymobiledevice3 11.45.0                 python -m pip install --only-binary :all: pymobiledevice3

注意：pip 直接装 pymobiledevice3 时如果没加 --only-binary :all:，会去尝试编译源码依赖，
可能卡很久。加了参数就走预编译 wheel，几十秒装完。

## 使用

    monitor_temp_ios.bat
    monitor_temp_ios.bat -Interval 2 -Csv D:\logs\ios.csv -Fresh
    monitor_temp_ios.bat -MaxSamples 120
    monitor_temp_ios.bat -Diag

参数：

    -Interval    采样间隔秒数，默认 5（单次读取实测约 0.5 秒）
    -Csv         CSV 路径，默认 temp_log_ios.csv
    -MaxSamples  采够多少条退出，0 为一直采
    -Fresh       清空重建 CSV；默认是追加
    -Diag        诊断模式，导出 ios_diag.txt
    -Deep        多试两个更慢的入口
    -Raw         打印底层原始返回
    -Mock        不接设备，用模拟温度跑流程
    -SelfTest    不接设备，自测解析与 CSV 格式

单独测试读取（不经 PowerShell）：

    python ios_temp_reader.py             # 输出 30.9
    python ios_temp_reader.py --json
    python ios_temp_reader.py --diag
    python ios_temp_reader.py --selftest

画图：

    把 plot_temp.py 里的 CSV_FILE 改成 "temp_log_ios.csv"，然后 python plot_temp.py

## 为什么不用 idevicediagnostics

传统教程都是 idevicediagnostics ioregentry AppleARMPMUCharger。
在你这台 iOS 26.5.2 上实测：AppleARMPMUCharger / AppleSMC / IOPMPowerSource 的
IORegistry 查询都返回空，diagnostics GasGauge 里也没有温度字段。
目前唯一有效的是 get_battery() 里的 Temperature。

脚本仍然保留 idevicediagnostics 通道（如果以后装上 libimobiledevice 会自动优先用），
但读不到时会自动退回 python 桥接，不需要你手动切换。

## 读不到怎么办

1. 手机解锁，插线，点“信任此电脑”。
2. 跑 monitor_temp_ios.bat -Diag，看 ios_diag.txt。
3. 如果报“无法连接设备”，检查 Apple Mobile Device Service 是否在运行：
       Get-Service 'Apple Mobile Device Service'
4. 如果连上了但没有温度字段，把 ios_diag.txt 发给我，按真实字段名再适配。

## 其他路线（供参考）

- 越狱：直接读 IOKit（AppleSMC / IOHIDEventSystemClient），电池、主板、CPU 温度都有，
  可以做成手机端独立记录，不依赖电脑。
- 只要热状态不要数值：iOS 11+ 的 ProcessInfo.thermalState，4 档（nominal/fair/serious/critical），
  需要写 App 或用 WebDriverAgent。
- App Store 上显示“电池温度”的 App 基本是估算，苹果没开放这个 API。
- 官方 sysdiagnose 里有热数据，但要导出后离线分析，不能实时采。

## 验证情况

- ios_temp_reader.py --selftest：9 项全过（量纲换算、统计值过滤、字段优先级）
- monitor_temp_ios.ps1 -SelfTest：9 项全过（解析、CSV 格式）
- 真机实测：iPhone18,3 / iOS 26.5.2，连续采样 30.8 -> 30.9，CSV 已用 plot_temp.py 的
  load_data 实际解析通过
- .bat 包装器：带参数运行正常
