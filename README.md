# ThermalStressTest

本项目是 cocos 温控系统的压测项目。目的：制造**可控、可标定**的 GPU / CPU 负载，验证温控模块降载是否有效——
降分辨率能降 GPU 负载、降帧率能降 CPU 负载、最终设备温度下降。

> 一句话记住两者的边界：**降分辨率只对 GPU 负载有效**。CPU 负载（脚本遍历、物理、AI）不会因为分辨率变小而变轻，
> 那种场景只能靠降帧率。实测已验证：1400 个立方体（≈24ms/帧）时，分辨率从 1.00 降到 0.30，帧时间几乎不变。

---

## 一、两类负载（可单开，也可混合）

| Slider | 控制项 | 压什么 | 判定场景 |
|---|---|---|---|
| GPU 层数 | `heatPlaneCount`（0~8） | 满屏 3D 平面层数，每层跑 64 次迭代的片元 shader（fill-rate / ALU） | 场景 A（GPU） |
| 立方体数量 | `spawnCount`（滑块 0~2000，命令可更大） | 每帧遍历 N 个立方体：自转/公转 + **每帧固定 `perCubeBaseOps` 次浮点运算** | 场景 B（CPU） |

**负载公式**（场景 B）：

```
每帧浮点运算量 ≈ 立方体数 × (perCubeBaseOps + cpuWorkPerCube)
```

`perCubeBaseOps` 默认 **4000**，`cpuWorkPerCube`（额外叠加）默认 **0**。

**关键约定**：

- `spawnCount = 0` → 场景 A（`update()` 里零遍历，一行循环都不进）；
- `spawnCount > 0` → 场景 B；
- **两者可以同时开**，混出来的就是混合负载。只是做归因/验收时别混着测：GPU 负载会让"降分辨率有没有用"变得说不清。

---

## 二、负载标定：先量，再选工作点

**为什么不能靠立方体数量猜负载**：60fps 下只要工作量 < 16.67ms，`ft_avg` 就恒等于 ~16.7ms——
**vsync 是一层地板，低于它的负载在帧时间上完全看不见**。实测 0、500、900 个立方体的 `ft_avg` 都在 16.2~17.8 之间，几乎一样。

所以标定要看 `cubeCpuMs`（脚本自己掐表，不受 vsync 影响）：

```js
stressTest.getStatus().cubeCpuMs     // { last, avg, perCubeUs }
stressTest.getStatus().cubeOpsPerFrame  // 每帧浮点运算量
```

**实测参考点**（Android 平板、60fps、温控关）：

| 立方体 | 每帧运算 | `ft_avg` | fps | `cubeCpuMs` |
| --: | --: | --: | --: | --: |
| 0 | 0 | 16.5 | 60 | ~0 |
| 500 | 2.0M | 16.6 | 60 | 被 vsync 掩盖 |
| 900 | 3.6M | 16.2~17.9 | 56~61 | 被 vsync 掩盖 |
| 1400 | 5.6M | **24.4** | 41 | 主要成本 |
| 2000 | 8.0M | **36.7** | 27 | 主要成本 |

**用法建议**：

- 场景 B 的 A/B 工作点取 **1100~1200 个**（≈ fps 46~49，正好"稳定超预算"但不失控）；
- 想让低数量也变重：加大 `perCubeBaseOps`（面板 / `setPerCubeBaseOps(n)`），斜率整体上移；
- 注意 **1000 个以上单立方体成本会上升**（5.4µs → 10.1µs，Node 的 transform/矩阵更新开始 cache miss），
  所以"数量 → 负载"不是严格线性，够用即可，别指望用公式精确推算。

---

## 三、GPU 压测逻辑

- GPU 压测点是场景根节点下的 **3D 平面**（`HeatPlane`，MeshRenderer + Quad），材质 `Mat_HeatShader3D`。
- 片元 shader（`HeatShader3D.effect`）是 64 次迭代纯乘加依赖链 + additive 混合 + depthTest off，每层都铺满全屏 → 负载 ≈ 层数 × 像素量。
- **必须挂在 3D 相机渲染目标上**：`shadingScale`（降分辨率）只缩放 3D 相机，不缩放 Canvas(UI_2D)。挂在 Canvas 下的 2D Sprite 不吃降分辨率，测不出收益。
- 场景 A 的 `update()` 里不能有遍历/矩阵运算——由 `spawnCount = 0` 保证（立方体列表为空，动画循环一次都不进）。

---

## 四、温控开关与验证入口

- 代码开关：`enableThermalControl` 属性（勾选 = 开温控）。构建两个包做 A/B 对比（开/关温控）。
- 降档顺序：默认先降 `shadingScale`，到底后再降帧率 `game.frameRate`；可用 `downgradeOrder` 切成相反顺序。
- **thermal 模块被功能裁剪时工程不会崩**：`cc.thermal === undefined` 时 `thermalBridge` 会跳过 FSR/温控并打印告警，
  只是这组数据只能当"温控关"用（`stressTest.thermalLevel()` 返回 -1）。

### 4.1 参数分两类，改法完全不同

| 类型 | 参数 | 怎么改 |
|---|---|---|
| **构建期**（必须在建包前配置好） | `enableThermalControl`、`thermalMinFrameRate`、`thermalMinScale`、`thermalWarmupSeconds`、`enableFsr`（初始值）、`enableAutoUpgrade`、`probeIntervalSeconds`、`recoveryProbeSeconds` | 面板 → **重新构建** |
| **运行期**（有 setter，改完立即生效） | `setTriggerPercent` / `setDowngradeOrder` / `setFsrEnabled` / `setFsrMinScale` / `setFps` / `setScale` / `thermalOn-Off-Down-Up` / `setSpawnCount` / `setHeatPlaneCount` / `setCpuWork` / `setPerCubeBaseOps` | 控制台（或 Storage 命令通道） |

> **每个参数的默认值、范围、坑，见 [参数手册.md](参数手册.md)**（39 个面板参数逐个说明）。
> 本文件只讲"怎么用"，手册负责"这个值该填多少"。

> `thermal.enable(config)` 只有**第一次**调用生效。第二次 `thermalOn()` 会打印
> `enable(config) only takes effect on the first call...` —— 这是契约，不是 bug。要改参数走 setter。

### 4.2 控制台入口（运行时挂在 `stressTest` 上）

```
负载   : setHeatPlaneCount(0~8) | setPlaneCoverage(0~1)
        setSpawnCount(n) | setCpuWork(0~2000) | setPerCubeBaseOps(0~10000)
温控   : thermalOn() | thermalOff() | thermalDown() | thermalUp() | thermalLevel()
        setTriggerPercent(%) | setDowngradeOrder('scale-first'|'frameRate-first')
FSR    : setFsrEnabled(bool) | setFsrMinScale(0.7) | diagFsr() | getThermal()
DRS    : setScale(1|0.85|0.7|0.3) | startDrsToggle() | stopDrsToggle()
诊断   : getStatus() | logStatus() | diagPlane() | printCsv(n)
数据   : startLogging() | stopLogging() | exportCsv() | cleanOldCsv()
```

`getStatus()` 里几个常用字段：`shadingScale` / `frameRate` / `thermalLevel` / `downgradeOrder` /
`cubes` / `gpuLayers` / `cubeCpuMs` / `cubeOpsPerFrame` / `csvGaps` / `drsConflict`。

### 4.3 Storage 命令通道（控制台看不到 `stressTest` 时用）

微信开发者工具的 Console 有时求值在**另一个上下文**，`stressTest` 会报 `ReferenceError`
（判据：`typeof GameGlobal.canvas === 'undefined'`）。Storage 是实例级共享的，所以给了这条通道：

```js
var s = (c) => wx.setStorageSync('__stressCmd', c);
s('status')        // 打印状态
s('down')          // 降一档
s('spawn:1500')    // 设负载
s('order:frameRate-first')
```

支持的写法：`down / up / on / off / pause / resume / status / print[:N] / level / diag / diagplane / log` 以及
`spawn:N / planes:N / scale:X / fps:N / trigger:N / cpu:N / base:N / order:xxx / fsr:on|off / fsrmin:X`。

> `diag` 会执行 `diagFsr()` 并把结果打到 `[StressTest] result:` 那行（F-02 验证 FSR 必备）。

限制：**0.5 秒轮询**、**一次只能排一条**（覆盖写），所以每敲一条要等日志出现
`[StressTest] exec: xxx`（以及 `result:`）再敲下一条。

---

## 五、数据采集（CSV）

每 5 秒一行，与 adb 温度采样对齐。表头（列名顺序保持兼容，分析脚本依赖）：

```
elapsed_s,ts_ms,fps,ft_avg_ms,ft_p95_ms,ft_max_ms,jank_gt_2x,battery_pct,
load_gpu_layers,spawn_count,shading_scale,frame_rate,fps_std,drop_rate,drop_rate_cur
```

| 字段 | 含义 |
|---|---|
| `fps` | 窗口平均帧率 = 1000 / ft_avg_ms |
| `ft_p95_ms` / `ft_max_ms` | 95 分位 / 最慢一帧的帧时间（**长间隔已过滤**，见下） |
| `jank_gt_2x` | 超过 2 倍采样起点预算（60fps → >33.3ms）的帧数，判真卡顿。**降到 30fps 后必然饱和到 ~100**，只能同帧率档内比较 |
| `fps_std` | 窗口内逐帧 FPS 标准差（抖动） |
| `drop_rate` | 相对**采样起点预算**（60fps → 16.667ms）的掉帧占比 %。口径固定，跨温控阶段可比。判据含 **5% 容差**（16.667 → 17.5ms） |
| `drop_rate_cur` | 相对**当前目标帧率**（1000/game.frameRate）的掉帧占比 %。温控降帧后应用它判"当前档位稳不稳"。同样含 5% 容差 |
| `load_gpu_layers` | 实际参与压测的平面层数（历史列名，场景 A 用） |
| `shading_scale` / `frame_rate` | 当前 DRS 档 / 帧率档 |

> 两个掉帧率的口径不同，**不要混用**：温控把目标帧率降到 30 后，`drop_rate` 会因为预算仍是 16.667ms 而恒报 ~100%，
> 但 `drop_rate_cur` 才是"当前档位下稳不稳"。判"温控后掉帧率有没有下降"用后者。

**切后台/断点的长间隔会被丢弃**：间隔 > 1000ms 不计入窗口（与引擎 `FrameTimeSampler` 同一阈值），
否则切后台 30 秒回来，`ft_max` 会变成 30000、`ft_avg` 被拉爆、整行数据作废。
丢弃次数在 `getStatus().csvGaps`，命令通道日志也会打一行 `忽略 xxxxxms 的长间隔…`。

**降档后的第一个 5 秒窗口统计的是旧分辨率**：`forceResizeAllWindows()` 之后要下一个窗口才反映新尺寸。
实测：0.70/0.30 两点拟合出 1.00 应为 38.5ms，而 0.85 档首个窗口实测 38.63ms（几乎重合）。
→ **评价某一档必须稳定 10~15 秒后再取样**，不要"降完档立刻读数"。

CSV 写入小游戏沙箱 `wx.env.USER_DATA_PATH/`：

- `thermal_latest.csv`：每 60s **覆盖写**的运行时快照（崩溃最多丢一个周期），文件名固定，不会堆一堆中间版本；
- `thermal_A_<时间戳>.csv` / `thermal_B_<时间戳>.csv`：`exportCsv()` 手动导出的归档，A/B 由 `enableThermalControl` 决定（关=A，开=B），两轮数据可直接按文件名区分；
- `printCsv(n)` 在控制台直接打印最近 n 行；每次启动会用 `cleanOldCsv()` 清掉上一次留下的 `thermal_*.csv`。

---

## 六、温度采集（宿主机侧）

部分平台，例如微信小游戏，运行时拿不到温度，测试验证时在宿主机采集设备电池温度作为 ground truth：

- Android：`monitor_temp.bat`（`adb dumpsys battery`，每 5s 一行 `Time,Temperature`）
- iOS：`monitor_temp_ios.bat`（libimobiledevice / pymobiledevice3）

---

## 七、数据分析与达标判定

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
python tools/eval/selftest.py     # 3 个场景 / 16 项检查：15 列正常口径 + 14 列兼容分支 + 负载不一致分支
```

---

## 八、已知限制与踩坑

| 现象 | 说明 / 规避 |
|---|---|
| 低负载时 `ft_avg` 看不出变化 | vsync 地板：< 16.67ms 的负载被掩盖。用 `cubeCpuMs` 量真实成本 |
| 降分辨率对 CPU 负载无效 | CPU 场景帧时间不随 `shadingScale` 变（实测 24ms 不变），要靠降帧率 |
| 降档后第一个窗口偏大 | 统计的是旧分辨率，等 10~15s 再取样 |
| `jank_gt_2x` 降到 30fps 后恒 ~100 | 稳态帧本身 33ms+ 已超 2×16.67，只能同档比较 |
| 开发者工具里 `stressTest` 未定义 | Console 求值在别的上下文，用 Storage 命令通道（§4.3） |
| 滑块不好点 | Slider 节点触摸区只有 300×20（`Handle` 32×32）；`cc.Slider` 按节点矩形判定，不是 Handle。建议把节点高度调到 60~80、`Handle` 调到 56×56 |
| 滑块调不准 | 300px 映射 2000 个立方体，1px ≈ 6.7 个；精确值请用 `setSpawnCount(n)` 或命令通道 |
| 立方体重建会卡一下 | `setSpawnCount(2000)` 有一帧 400~600ms 的实例化尖峰，那个 5s 窗口别采样 |

---

## 九、目录结构

```
参数手册.md                       # 每个面板参数的默认值/阶段/用法（本文件只做速查）
assets/
  scene.scene                     # 主场景（单场景双滑块）
  script/StressTestController.ts  # 压测控制器（核心：面板属性、对外 API、命令通道、getStatus）
  script/thermal-bridge.ts        # 温控门面封装（enable/step/FSR/降档顺序，含 thermal 缺失保护）
  script/csv-recorder.ts          # CSV 采集与导出（5s 一行、长间隔过滤、A/B 命名、快照）
  script/cpu-cubes.ts             # 场景 B：立方体的生成/销毁/逐帧动画 + 每帧固定运算量 + CPU 计时
  script/heat-plane.ts            # 场景 A：满屏平面层数/覆盖/着色/压测探针
  script/drs-probe.ts             # 手动分辨率 A/B 探针（与温控互斥）
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
