# tools/charts — 实验对比图生成器

把温控 A/B 实验的原始 CSV + 温度日志画成对比图（温度走势 / 帧率走势 / 分辨率档位 / 温升汇总）。

## 用法

```powershell
python tools/charts/make_charts.py <实验数据目录> <输出目录>

# 例（红米 K30）
python tools/charts/make_charts.py "C:\Users\Administrator\Desktop\温控一期测试\正式AB实验\实验数据\redmik30" "...\正式AB实验\图"
```

## 输入

| 文件 | 需要的列 |
| :-- | :-- |
| `<机型>_<条件>_<次>.csv` | `elapsed_s`、`fps`、`shading_scale` |
| `<机型>_<条件>_<次>_temp.csv` | 两列：`HH:MM:SS.ss,Temperature` |

温度日志的时间列是**墙钟时间**（不是 epoch 毫秒），脚本里做了 `HH:MM:SS.ss` 解析 + 跨零点处理。

## 输出

| 文件 | 内容 |
| :-- | :-- |
| `01_温度_GPU组.png` | GA / GB / GB2 温度曲线 |
| `02_温度_CPU组.png` | CA / CB / CB2 / CB3 温度曲线 |
| `03_帧率_CPU组.png` | CPU 组帧率（5 点滑动平均） |
| `04_分辨率_CPU组.png` | 分辨率档位（看自动升档是否把降档撤回） |
| `05_温升汇总.png` | 各轮 ΔT 柱状（含 IDLE 底噪） |

## 加一条曲线

1. 在 `SERIES` 里加一行：`'GBF': ('#16a085', 'GBF 只降分辨率+FSR关'),`
2. 把条件码加进对应 `chart_*()` 调用的列表，例如 `['GA', 'GB', 'GB2', 'GBF']`

条件码 = 文件名里 `<机型>_` 与 `_<次>` 之间的部分。

## 依赖

- Python 3.8+
- Pillow（`pip install pillow`）
- 中文字体：`C:/Windows/Fonts/msyh.ttc`（缺失时回落 `simhei.ttf`）

## 口径提醒

- ΔT 取**温度日志首末值**；`工具/汇总实验.js` 的表是**按 CSV 时长对齐**后算的，两者可能差 0.1℃；
- 帧率曲线做了 5 点滑动平均，否则 5 秒一个采样点画出来锯齿太密；
- 曲线自动降采样到 400 点，图不会因采样点多而糊。
