#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""make_ios_summary.py —— iOS 温控结论图（给汇报用）

一句话要说明的事：
    **无论 CPU 负载还是 GPU 负载，iOS 的帧率往下掉时，温度曲线几乎重合，
      可用的"温控区间"非常窄。**

两张子图：
  左：苹果 13 三轮的温度-时间曲线（空场景 / GPU 6 层 / CPU 400 立方体）
      —— 曲线几乎重叠，说明加负载不改变温度走势
  右：温度 vs 稳态帧率（苹果 17 六轮 + 苹果 13 三轮）
      —— 帧率从 60 掉到 13，温度几乎是一条水平线

测量方法（图注里必须写明）：
  苹果 17（iOS 26）用系统接口读**电池温度**；
  苹果 13（iOS 27.0.1）**系统已移除该接口**，改用**红外测温枪**测背面贴纸表面温度。

用法：
    python tools/charts/make_ios_summary.py
"""
import argparse
import os
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
from matplotlib.ticker import MultipleLocator

for cand in ('Microsoft YaHei', 'SimHei', 'PingFang SC', 'Noto Sans CJK SC'):
    if any(f.name == cand for f in fm.fontManager.ttflist):
        plt.rcParams['font.sans-serif'] = [cand]
        break
plt.rcParams['axes.unicode_minus'] = False

# ---------------------------------------------------------------- 苹果 13 温度（人工点测）
T13 = {
    'IDLE 空场景 60fps':      ([0, 5, 10, 15, 20, 25, 30], [25.5, 35.1, 37.0, 38.3, 39.3, 40.5, 40.1], '#2c3e50', 2.6),
    'GPU 6 层（15fps）':       ([0, 5, 10, 15, 20, 25, 30], [25.3, 34.8, 38.4, 39.5, 41.2, 41.3, 41.0], '#c0392b', 2.4),
    'CPU 400 立方体（15.5fps）': ([0, 5, 10, 15, 20, 25, 30], [25.4, 33.0, 35.7, 37.1, 38.0, 38.5, 38.7], '#16a085', 2.4),
}

# ---------------------------------------------------------------- 温度 vs 帧率
# (稳态帧率, 终点温度, 标签, 是否 CPU 负载)
P17 = [
    (60.0, 42.8, '空场景', False),
    (23.9, 42.8, 'GPU 7 层', False),
    (21.0, 42.7, 'GPU 7 层+限帧', False),
    (14.8, 42.8, 'GPU 12 层', False),
    (13.0, 42.7, 'CPU 1000', True),
]
P13 = [
    (59.6, 40.1, '空场景', False),
    (12.5, 41.0, 'GPU 6 层', False),
    (15.5, 38.7, 'CPU 400', True),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=r'C:\Users\Administrator\Desktop\温控一期测试\正式AB实验\图_苹果17')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14.6, 6.0), dpi=130)

    # ---------------- 左：苹果 13 时间曲线 ----------------
    for label, (xs, ys, color, lw) in T13.items():
        ax1.plot(xs, ys, marker='o', markersize=4.5, color=color, linewidth=lw, label=label)
    ax1.axhline(40.3, color='#bdc3c7', linestyle='--', linewidth=1.4, zorder=0)
    ax1.set_xlim(-1, 31)
    ax1.set_ylim(24, 44)
    ax1.set_xlabel('起跑后分钟数', fontsize=11.5)
    ax1.set_ylabel('机身表面温度 ℃（测温枪）', fontsize=11.5)
    ax1.set_title('苹果 13 · 三种负载的温度走势几乎重合', fontsize=13, fontweight='bold', pad=10)
    ax1.xaxis.set_major_locator(MultipleLocator(5))
    ax1.yaxis.set_major_locator(MultipleLocator(2))
    ax1.grid(True, color='#ecf0f1')
    ax1.set_axisbelow(True)
    for s in ('top', 'right'):
        ax1.spines[s].set_visible(False)
    ax1.legend(loc='lower right', fontsize=10.5, framealpha=0.95)
    ax1.annotate('30 分钟终点：\n40.1 / 41.0 / 38.7℃\n跨度仅 2.3℃',
                 xy=(30, 39.9), xytext=(16.5, 28.5), fontsize=10.5, color='#555555',
                 arrowprops=dict(arrowstyle='->', color='#95a5a6', lw=1.2))

    # ---------------- 右：温度 vs 帧率 ----------------
    for pts, name, color, mk in ((P17, '苹果 17（电池温度，iOS 26）', '#c0392b', 'o'),
                                 (P13, '苹果 13（贴纸表面温度，iOS 27）', '#2980b9', 's')):
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        ax2.plot(xs, ys, linestyle='none', marker=mk, markersize=9, color=color, label=name)
        # 连成水平参考线
        ax2.axhline(sum(ys) / len(ys), color=color, linewidth=1.0, alpha=0.35)

    # 苹果 17：只标两端，中间一簇用一句话带过（避免标签互相压住）
    ax2.annotate('空场景 60fps', (60.0, 42.8), textcoords='offset points', xytext=(0, -14),
                 ha='center', fontsize=9.2, color='#c0392b')
    ax2.annotate('', xy=(18.5, 42.75), xytext=(27.5, 40.7),
                 arrowprops=dict(arrowstyle='->', color='#c0392b', lw=1.0, alpha=0.6))
    ax2.text(27.8, 40.45,
             'GPU 7 层 / GPU 12 层 / GPU+限帧 / CPU 1000 立方体\n全部落在同一条水平线（42.7~42.8℃）',
             fontsize=8.9, color='#c0392b', va='bottom', ha='left', linespacing=1.6)
    # 苹果 13：三点彼此分得开，直接标
    for x, y, label, is_cpu in P13:
        if label == '空场景':
            ax2.annotate(label, (x, y), textcoords='offset points', xytext=(-9, 2),
                         ha='right', fontsize=9.0, color='#2980b9')
        else:
            ax2.annotate(label, (x, y), textcoords='offset points', xytext=(0, 11),
                         ha='center', fontsize=9.0, color='#2980b9')

    ax2.axvline(20, color='#7f8c8d', linestyle=':', linewidth=1.6)
    ax2.text(20.6, 37.3, '20fps\n可玩下限', fontsize=9.5, color='#7f8c8d', va='center')
    ax2.axvspan(0, 20, color='#f5f5f5', zorder=0)

    ax2.set_xlim(0, 66)
    ax2.set_ylim(36, 45)
    ax2.set_xlabel('稳态帧率 fps', fontsize=11.5)
    ax2.set_ylabel('30 分钟终点温度 ℃', fontsize=11.5)
    ax2.set_title('帧率从 60 掉到 13，温度几乎不变', fontsize=13, fontweight='bold', pad=10)
    ax2.xaxis.set_major_locator(MultipleLocator(10))
    ax2.yaxis.set_major_locator(MultipleLocator(1))
    ax2.grid(True, color='#ecf0f1')
    ax2.set_axisbelow(True)
    for s in ('top', 'right'):
        ax2.spines[s].set_visible(False)
    ax2.legend(loc='lower right', fontsize=10, framealpha=0.95)

    fig.suptitle('iOS 温控空间评估：帧率下降 75%，温度跨度只有 0.1~2.3℃',
                 fontsize=15.5, fontweight='bold', y=0.985)
    fig.text(0.5, 0.028,
             '左：苹果 13 三轮实测（温控关，30 分钟，屏幕 10% 亮度，全程插线）   '
             '右：苹果 17 六轮 + 苹果 13 三轮，取各轮 30 分钟终点温度',
             ha='center', fontsize=9.6, color='#555555')
    fig.text(0.5, 0.004,
             '测量方法：苹果 17（iOS 26）读系统电池温度；'
             '苹果 13（iOS 27.0.1）系统已移除温度接口，改用红外测温枪测机身背面贴纸表面温度',
             ha='center', fontsize=9.6, color='#8e44ad')

    fig.tight_layout(rect=(0, 0.055, 1, 0.955))
    out = os.path.join(args.out, '02_iOS结论_帧率与温度.png')
    fig.savefig(out)
    print('写出:', out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
