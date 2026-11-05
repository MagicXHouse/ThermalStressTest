# ThermalStressTest

本项目是cocos温控系统的压测项目。目的：制造可控的 GPU / CPU 负载，验证温控模块降载是否有效——**降分辨率能降 GPU 负载、降帧率能降 CPU 负载、设备温度下降**。

## 一、双滑块 = 两类负载

单场景内靠两个 Slider 分别压 GPU 和 CPU，**不需要拆两个场景**：

| Slider | 控制项 | 压什么 | 对应场景 |
|---|---|---|---|
| GPU 层数 | `heatPlaneCount`（0~8） | 满屏 3D 平面层数，每层跑 64 次迭代的片元 shader（fill-rate / ALU） | 场景 A（GPU） |
| 立方体数量 | `spawnCount`（0~2000） | 每帧遍历 N 个立方体做自转/公转（脚本计算 + 世界矩阵更新） | 场景 B（CPU） |

**关键约定**：`spawnCount = 0` 时是场景 A（纯 GPU，`update()` 里零遍历）；`spawnCount > 0` 时是场景 B（CPU 负载）。两套场景共用同一个 `StressTestController`。

## 二、GPU压测逻辑

- GPU 压测点是场景根节点下的 **3D 平面**（`HeatPlane`，MeshRenderer + Quad），材质 `Mat_HeatShader3D`。
- 片元 shader（`HeatShader3D.effect`）是 64 次迭代纯乘加依赖链 + additive 混合 + depthTest off，每层都铺满全屏 → 负载 ≈ 层数 × 像素量。
- **必须挂在 3D 相机渲染目标上**：`shadingScale`（降分辨率）只缩放 3D 相机，不缩放 Canvas(UI_2D)。挂在 Canvas 下的 2D Sprite 不吃降分辨率，测不出收益。
- 场景 A 的 `update()` 里不能有遍历/矩阵运算——由 `spawnCount = 0` 保证（立方体列表为空，动画循环一次都不进）。

## 三、温控开关与验证入口

- 代码开关：`enableThermalControl` 属性（勾选 = 开温控）。构建两个包做 A/B 对比（开/关温控）。
- 降档顺序：先降 `shadingScale`（场景 A 要验证的杠杆），到底后再降帧率 `game.frameRate`。
- **thermal 模块被功能裁剪时工程不会崩**：`cc.thermal === undefined` 时 `thermalBridge` 会跳过 FSR/温控并打印告警，
  只是这组数据只能当"温控关"用（`stressTest.thermalLevel()` 返回 -1）。

### 控制台入口（运行时挂 `globalThis.stressTest`）

```
A/GPU : setHeatPlaneCount(1~8) | setPlaneCoverage(0~1) | setParticleRate(n)
B/CPU : setSpawnCount(n) | setCpuWork(0~2000) | setColorEnabled(true|false)
drs   : setScale(1|0.85|0.7|0.3) | thermalOn() | thermalOff() | thermalDown() | thermalUp()
        startDrsToggle() | stopDrsToggle() | setTriggerPercent(10)
diag  : diagPlane() | diagFsr() | getStatus() | logStatus() | exportCsv() | printCsv(n)
```

## 四、数据采集（CSV）

每 5 秒一行，与 adb 温度采样对齐。表头（列名顺序保持兼容，分析脚本依赖）：

```
elapsed_s,ts_ms,fps,ft_avg_ms,ft_p95_ms,ft_max_ms,jank_gt_2x,battery_pct,
load_gpu_layers,spawn_count,shading_scale,frame_rate,fps_std,drop_rate,drop_rate_cur
```

| 字段 | 含义 |
|---|---|
| `fps` | 窗口平均帧率 = 1000 / ft_avg_ms |
| `ft_p95_ms` / `ft_max_ms` | 95 分位 / 最慢一帧的帧时间 |
| `jank_gt_2x` | 超过 2 倍预算（>33.3ms）的帧数，判真卡顿 |
| `fps_std` | 窗口内逐帧 FPS 标准差（抖动） |
| `drop_rate` | 相对**采样起点预算**（60fps → 16.667ms）的掉帧占比 %。口径固定，跨温控阶段可比。判据含 **5% 容差**（16.667 → 17.5ms） |
| `drop_rate_cur` | 相对**当前目标帧率**（1000/game.frameRate）的掉帧占比 %。温控降帧后应用它判"当前档位稳不稳"。同样含 5% 容差 |
| `load_gpu_layers` | 实际参与压测的平面层数（历史列名，场景 A 用） |
| `shading_scale` / `frame_rate` | 当前 DRS 档 / 帧率档 |

> 两个掉帧率的口径不同，**不要混用**：温控把目标帧率降到 30 后，`drop_rate` 会因为预算仍是 16.667ms 而恒报 ~100%，但 `drop_rate_cur` 才是"当前档位下稳不稳"。判"温控后掉帧率有没有下降"用后者。

CSV 写入小游戏沙箱 `wx.env.USER_DATA_PATH/`：

- `thermal_latest.csv`：每 60s **覆盖写**的运行时快照（崩溃最多丢一个周期），文件名固定，不会堆一堆中间版本；
- `thermal_A_<时间戳>.csv` / `thermal_B_<时间戳>.csv`：`exportCsv()` 手动导出的归档，A/B 由 `enableThermalControl` 决定（关=A，开=B），两轮数据可直接按文件名区分；
- `printCsv(n)` 在控制台直接打印最近 n 行；每次启动会用 `cleanOldCsv()` 清掉上一次留下的 `thermal_*.csv`。

## 五、温度采集（宿主机侧）

部分平台，例如微信小游戏，运行时拿不到温度，测试验证时在宿主机采集设备电池温度作为 ground truth：

- Android：`monitor_temp.bat`（`adb dumpsys battery`，每 5s 一行 `Time,Temperature`）
- iOS：`monitor_temp_ios.bat`（libimobiledevice / pymobiledevice3）

## 六、数据分析与达标判定

`tools/eval/_eval_thermal.py`：把温控前/后两组 CSV + 两份温度日志拉齐，按方案 §4.5 出判定。

- **合入门槛（判定项）**：两轮负载一致（前置校验）、平均温度下降（核心，取**最后 15 分钟稳态窗口**）、
  掉帧率下降（用 `drop_rate_cur`）、帧率标准差下降
- **仅参考（不判定）**：平均帧率、p95 帧时间 —— 降帧率杠杆下这两项天然恶化；
  另打印"相对起点的升温幅度"，用来抵消两轮起始温度/室温差异
- 温度阈值 `TEMP_DROP_MIN`、抖动阈值 `STD_DROP_MIN`、稳态窗口 `STEADY_MINUTES` 在脚本顶部，实测后标定
- 两轮 `load_gpu_layers` / `spawn_count` 不一致（或某一轮中途改过负载）会直接判 FAIL 并提示"结论无效"
- 旧版 14 列 CSV 会走兼容分支：提示缺 `drop_rate_cur`，回退用 `drop_rate` 判并警告"结论可能误判"
- 数据路径可用环境变量覆盖（`THERMAL_BASE_CSV` / `THERMAL_THERM_CSV` / `THERMAL_BASE_TEMP` / `THERMAL_THERM_TEMP`），
  不设则用脚本顶部默认值

改脚本后跑一遍自测（合成数据，不需要真机）：

```bash
python tools/eval/selftest.py     # 15 列正常口径 + 14 列兼容分支 + 负载不一致分支
```

## 七、目录结构

```
assets/
  scene.scene                     # 主场景（单场景双滑块）
  script/StressTestController.ts  # 压测控制器（核心）
  script/SliderBinder.ts          # Slider 绑定封装
  prefab/Cube.prefab              # 场景 B 的 instanced 立方体
  shader/HeatShader3D.effect      # 场景 A 的满屏 64 迭代片元 shader
  shader/InstancedColor.effect    # 场景 B 的 instanced 颜色 shader
  material/Mat_HeatShader3D.mtl   # HeatPlane 材质
  material/Mat_InstancedColor.mtl # Cube 材质
  resources/fsr/builtin-fsr.mtl   # FSR 材质
tools/
  device-monitor/                 # 宿主机温度采集（Android adb / iOS idevicediagnostics）
  eval/_eval_thermal.py           # 温控前后 CSV + 温度日志 → 达标判定
  eval/selftest.py                # 判定脚本的自测（合成数据）
  module-tests/                   # 拆分后脚本模块的运行时断言（node + cc stub）
```
