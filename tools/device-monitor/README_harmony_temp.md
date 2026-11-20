# 鸿蒙（HarmonyOS NEXT）温度采集

> 面向 **HarmonyOS NEXT**（5.0 / 6.0 / 7.0…，去掉了 Android 运行时）。
> 已在 **华为 Mate 60 / HarmonyOS 7.0.0 / hdc 3.2.0f** 实机验证。

## 为什么不能用 Android 那套

| | Android（含 HarmonyOS 4.x 及更早） | **HarmonyOS NEXT** |
| :-- | :-- | :-- |
| 调试工具 | `adb` | **`hdc`**（华为工具，随 DevEco Studio / Command Line Tools 提供） |
| 温度来源 | `adb shell dumpsys battery` 的 `temperature` | `hdc shell "hidumper -s BatteryService -a '-i'"` 的 `temperature` |
| 单位 | 0.1℃ | **同样 0.1℃**（→ 与其它机型可直接比） |

`adb devices` 在 NEXT 上**永远是空的**，这不是驱动问题。

## 一、准备 hdc

Command Line Tools 解压后的路径大概是：

```
<解压目录>\sdk\default\openharmony\toolchains\hdc.exe
```

验证：

```powershell
hdc version          # Ver: 3.2.0f
hdc list targets     # 设备号；出现 Unauthorized 说明手机没授权
```

> 首次连接：手机解锁 → 弹窗「允许调试」勾**始终允许**；
> 没弹窗就去「设置 → 系统 → 开发者选项」点「撤销 USB 调试授权」再插线。

## 二、探测可用通道

```powershell
.\probe_harmony_temp.ps1
# 或指定路径
.\probe_harmony_temp.ps1 -HdcPath "D:\...\toolchains\hdc.exe"
```

会打印：型号 / 系统版本 / 两条温度通道（BatteryService、ThermalService）/ sysfs 是否可读 / 应用沙箱是否可读。

实测输出（Mate 60 空载，室温 24℃）：

```
[2] BatteryService → temperature: 240  →  24.0 ℃
[3] ThermalService → 8 个 zone：
       system_h      26.3 ℃
       charger       25.9 ℃
       shell_frame   25.4 ℃
       shell_front   25.4 ℃
       shell_back    24.0 ℃
       Battery       24.0 ℃
       rfboard       23.9 ℃
       ambient       17.9 ℃
[4] /sys/class/thermal → Permission denied（SELinux）
[5] 应用沙箱 → Permission denied（拿不到小游戏 CSV）
```

## 三、采温度

**双击（或命令行）用 .bat 最省事**（自动找 hdc、自动给默认输出文件）：

```
monitor_temp_harmony.bat                                  :: 5 秒一次 -> temp_log_harmony.csv
monitor_temp_harmony.bat -Interval 2 -Out run1.csv
monitor_temp_harmony.bat -Source thermal -Zone shell_back -Out body.csv
monitor_temp_harmony.bat -HdcPath "C:\path\to\hdc.exe"
```

运行时的行为：

| 行为 | 说明 |
| :-- | :-- |
| **先删旧文件** | 启动时若目标 CSV 已存在，先 `Remove-Item` 再写表头，并打印「已删除旧文件」——避免两轮数据混在一个文件里污染 ΔT 基线 |
| **每个点都打印** | 控制台逐行输出 `#  1  12:04:01.72  23.0 ℃`，一眼能看出在跑还是卡住 |
| **读不到就写 NA** | 不沿用上一次的读数（沿用会让数据看起来平滑，实际是假的） |
| **连续 3 次 NA 告警** | 提示检查 hdc 连接与手机授权 |

也可以直接调 PowerShell（参数更全，含 `-Quiet` 只写文件不打印）：

```powershell
# 主口径：电池温度（与 Android 的 dumpsys battery 同单位、同物理量）
.\monitor_temp_harmony.ps1 -Out .\temp_log.csv -Interval 5

# 辅助：机身背面 / SoC
.\monitor_temp_harmony.ps1 -Out .\temp_log_shell.csv -Interval 5 -Source thermal -Zone shell_back
.\monitor_temp_harmony.ps1 -Out .\temp_log_soc.csv   -Interval 5 -Source thermal -Zone system_h

# 后台/批处理用：只写文件，不刷屏
.\monitor_temp_harmony.ps1 -Out .\temp_log.csv -Quiet
```

输出格式与 Android 版一致：`Time,Temperature`，5 秒一行 —— 现有的
`汇总实验.js` / `体检单轮.js` 直接能用。

**口径约定**：主指标一律用 **BatteryService 的 battery temperature**，
`shell_back` / `system_h` 只作为辅助证据，不要混进主表。

## 三·五、兜底：从控制台回滚恢复温度数据

> 鸿蒙 NEXT 上应用沙箱读不到，**唯一可靠的"副本"是采集脚本打到控制台的那一行行输出**
> （每个采样点打印 `# 12  16:24:10.82  33.0 ℃`）。文件被误删或覆盖时，可以从窗口回滚里还原。

步骤：

1. PowerShell 窗口里 **右键 → 全选 → 回车**（或 `Ctrl+A` 后 `Ctrl+C`），粘贴到一个文本文件，例如 `console.txt`；
2. 用时间窗把本轮切出来（控制台里往往混着前几轮的输出）：

```powershell
.\parse_console_temp.ps1 -In console.txt -Out recovered.csv -Since 16:14:00 -Until 16:50:00

# 前半段从控制台恢复 + 后半段从还在写的文件里拿，按时间戳去重排序
.\parse_console_temp.ps1 -In console.txt -Out merged.csv -Since 16:14:00 -Merge temp_log_harmony.csv
```

`NA（读不到）` 的行会被自动跳过。

## 四、注意：CSV 取不回来

NEXT 的 shell 读不到应用沙箱，三条路都 `Permission denied`：

```
/data/app/el2/100/base
/data/storage/el2/base
/storage/media/100/local/files
```

所以 `hdc file recv` **拿不到**小游戏写的 `thermal_*.csv`。数据要靠游戏内的分页复制：

```js
s('csvpages')      // 30 分钟数据 ≈ 360 行 ≈ 3 页
s('copypage:1')    // 每页 120 行 ≈ 9KB，剪贴板不会截断
s('copypage:2')
s('copypage:3')
```

每复制一页立刻粘到微信「文件传输助手」或备忘录，最后在 PC 上按顺序拼回一个文件。

## 五、坑

1. **别插线跑测**：快充发热会污染温度；温度采完、要传数据时再插；
2. **`/sys/class/thermal` 别指望**：NEXT 上 SELinux 挡死，`cat` 也 Permission denied；
3. **ze 单位别搞混**：BatteryService 是 0.1℃，ThermalService 是 0.001℃——两个脚本已经各自除好了；
4. **刷新率要固定成 60Hz**（LTPO 机型自适应会破坏限帧实验），这是压测侧的事，不在本脚本范围。
