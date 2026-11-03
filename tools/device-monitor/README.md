# 设备温度采集脚本

配合 `ThermalStressTest` 的温控压测使用：跑压力场景时同步采设备温度，事后和 CSV 里的
`fps / ft_avg_ms / shading_scale` 对齐，看"降分辨率到底有没有把温度压住"。

脚本不依赖本项目代码，拷到别的工程也能用（全是相对路径）。

## Android

```
monitor_temp.bat
```

- 依赖 `adb`（在 PATH 里），设备已 `adb devices` 可见。
- 通过 `adb shell dumpsys battery` 的 `temperature` 字段取值（单位 0.1℃）。
- 每 5 秒一行，输出 **`temp_log.csv`**（`Time,Temperature`），写在**当前工作目录**。
  双击运行时工作目录就是本文件夹。

## iOS

```
monitor_temp_ios.bat
```

- 双击入口，内部调 `monitor_temp_ios.ps1`（`-ExecutionPolicy Bypass`）。
- iOS 没有 adb，也没有公开 API 读电池温度，走的是 `idevicediagnostics` 的 IORegistry /
  诊断通道；没装 libimobiledevice 时自动退回 `pymobiledevice3` 的 Python 桥接（`ios_temp_reader.py`）。
- 默认输出 **`temp_log_ios.csv`**，参数见 `README_ios_temp.md`：
  ```
  monitor_temp_ios.bat -Interval 2 -Csv D:\logs\ios.csv -Fresh
  monitor_temp_ios.bat -Diag      # 读不到温度时先跑这个，生成 ios_diag.txt
  monitor_temp_ios.bat -SelfTest  # 不需要设备，自检解析与 CSV 格式
  ```

## 画温度曲线

```
python plot_temp.py
```

`plot_temp.py` 顶部改 `CSV_FILE`（默认 `temp_log.csv`）和 `OUTPUT_IMG` 即可，两个平台产出的
CSV 格式一致（`Time,Temperature`）。需要 `pandas` + `matplotlib`。

## 和其它数据的对齐

温度 CSV 只有 `HH:mm:ss`，压测 CSV 有绝对时间戳 `ts_ms`。同时开始时，用**开始时间**把两条
时间轴对齐即可；建议压测开始后再启动温度采集，并记下启动时刻。

## 运行产物（不要提交）

`*.csv` / `ios_diag.txt` 已由本目录的 `.gitignore` 排除。
