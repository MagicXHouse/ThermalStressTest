#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""苹果 17 各负载场景的温度对比图（matplotlib 版）

目的：一眼看出「负载越高升温越快」和「最终都被摁在 ~43℃」这两件事是不是同时成立。

对齐方式：每轮都以**自己的起跑时刻**为 0 分钟（CSV 的 ts_ms），
而不是温度日志的第一条 —— 温度采集常常比游戏起跑早几十秒（见 README 里那条"每轮自动清空"的教训）。

用法：
  python tools/charts/apple17_temp_compare.py
  python tools/charts/apple17_temp_compare.py --data "<数据目录>" --out "<输出目录>"
"""
import argparse
import datetime
import os
import re
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
from matplotlib.ticker import MultipleLocator

# ---------------------------------------------------------------- 中文
for cand in ('Microsoft YaHei', 'SimHei', 'PingFang SC', 'Noto Sans CJK SC'):
    if any(f.name == cand for f in fm.fontManager.ttflist):
        plt.rcParams['font.sans-serif'] = [cand]
        break
plt.rcParams['axes.unicode_minus'] = False

# ---------------------------------------------------------------- 轮次定义
# (条件码, 中文图例, 颜色, 线宽)
SERIES = [
    ('WXONLY', '只开微信（不进小游戏）',      '#7f8c8d', 2.4),
    ('IDLE',   '游戏内空场景 60fps',           '#2c3e50', 2.4),
    ('CA',     'CPU 300 立方体',               '#16a085', 2.2),
    ('CAH',    'CPU 1000 立方体',              '#27ae60', 2.2),
    ('GA',     'GPU 7 层平面',                 '#e67e22', 2.2),
    ('GBR',    'GPU 7 层 + 限帧 30→20',        '#8e44ad', 2.2),
    ('GAH',    'GPU 12 层平面',                '#c0392b', 2.6),
]


def parse_hms(s):
    p = s.strip().split(':')
    if len(p) != 3:
        return None
    try:
        return int(p[0]) * 3600 + int(p[1]) * 60 + float(p[2])
    except ValueError:
        return None


def read_temp(path):
    """返回 [(当天秒数, 温度)]"""
    pts = []
    with open(path, encoding='utf-8-sig') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split(',')
            if len(parts) < 2:
                continue
            sec = parse_hms(parts[0])
            if sec is None:            # 表头 Time,Temperature
                continue
            try:
                v = float(parts[1])
            except ValueError:
                continue
            pts.append((sec, v))
    return pts


def read_start_sec(csv_path):
    """从 CSV 的 ts_ms 取起跑时刻（当天秒数）"""
    with open(csv_path, encoding='utf-8-sig') as f:
        head = f.readline().strip().split(',')
        try:
            i = head.index('ts_ms')
        except ValueError:
            return None
        row = f.readline().strip().split(',')
        if len(row) <= i:
            return None
        dt = datetime.datetime.fromtimestamp(int(row[i]) / 1000.0)
        return dt.hour * 3600 + dt.minute * 60 + dt.second


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=r'C:\Users\Administrator\Desktop\温控一期测试\正式AB实验\实验数据\apple17')
    ap.add_argument('--out', default=r'C:\Users\Administrator\Desktop\温控一期测试\正式AB实验\图_苹果17')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    fig, ax = plt.subplots(figsize=(11.5, 6.6), dpi=130)
    ends = []
    for cond, label, color, lw in SERIES:
        tpath = os.path.join(args.data, 'iphone17_%s_1_temp.csv' % cond)
        if not os.path.exists(tpath):
            print('  跳过（缺温度日志）', cond)
            continue
        cpath = os.path.join(args.data, 'iphone17_%s_1.csv' % cond)
        pts = read_temp(tpath)
        if not pts:
            continue
        start = read_start_sec(cpath) if os.path.exists(cpath) else None
        if start is None:
            # 没有主 CSV（WXONLY）：用温度日志自己的第一条当 0 分钟
            start = pts[0][0]
            note = '(自日志起算)'
        else:
            note = ''
        xs = [(s - start) / 60.0 for s, _ in pts if 0 <= (s - start) / 60.0 <= 32]
        ys = [v for s, v in pts if 0 <= (s - start) / 60.0 <= 32]
        if not xs:
            continue
        ax.plot(xs, ys, color=color, linewidth=lw, label=label)
        ends.append((label, xs[-1], ys[-1]))
        print('  %-28s %5.1f 分钟  %.1f → %.1f℃' % (label, xs[-1], ys[0], ys[-1]))

    # 43℃ 参考线
    ax.axhline(42.8, color='#bdc3c7', linestyle='--', linewidth=1.6, zorder=0)
    ax.text(31.2, 42.8, '≈42.8℃\n全部撞线', color='#7f8c8d', fontsize=10.5,
            va='center', ha='left', linespacing=1.4)
    ax.axhline(26.4, color='#ecf0f1', linestyle=':', linewidth=1.2, zorder=0)
    ax.text(31.2, 26.4, '起点≈26.5℃', color='#95a5a6', fontsize=9.5, va='center', ha='left')

    ax.set_xlim(0, 31)
    ax.set_ylim(24, 45)
    ax.set_xlabel('起跑后分钟数', fontsize=12)
    ax.set_ylabel('机身（电池）温度 ℃', fontsize=12)
    ax.set_title('苹果 17 · 各负载场景的升温曲线对比', fontsize=15, fontweight='bold', pad=14)
    ax.xaxis.set_major_locator(MultipleLocator(5))
    ax.yaxis.set_major_locator(MultipleLocator(2))
    ax.grid(True, color='#ecf0f1', linewidth=1.0)
    ax.set_axisbelow(True)
    for side in ('top', 'right'):
        ax.spines[side].set_visible(False)
    ax.legend(loc='upper left', frameon=True, fontsize=10.5, framealpha=0.95)

    fig.text(0.5, 0.045,
             '数据：iPhone 17 · 屏幕亮度 10% · 全程插线 · 各轮起点 26~28℃'
             '（CA / WXONLY 无主数据 CSV，按温度日志起点对齐）\n'
             '结论：六条曲线中段最大只差约 2℃，25 分钟后全部收敛到 42.7~42.8℃',
             ha='center', fontsize=10, color='#555555')

    out = os.path.join(args.out, '01_苹果17_温度对比_各负载.png')
    fig.tight_layout(rect=(0, 0.10, 1, 1))
    fig.savefig(out)
    print('\n写出:', out)

    # 终点汇总
    print('\n终点：')
    for label, x, y in sorted(ends, key=lambda e: -e[2]):
        print('  %-28s %5.1f 分钟  %.1f℃' % (label, x, y))


if __name__ == '__main__':
    sys.exit(main())
