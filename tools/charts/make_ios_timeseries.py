#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""make_ios_timeseries.py —— 四张"随时间变化"的图（温度 / 帧率，两台机器各两张）

为什么要拆成四张：汇报时"温度几乎不动、帧率断崖式下跌"这种对比，
把两条曲线放在同一张图上会互相压扁；拆开后各自占满版面，冲击力更强。

输出：
    03_苹果13_温度随时间.png
    04_苹果13_帧率随时间.png
    05_苹果17_温度随时间.png
    06_苹果17_帧率随时间.png

数据来源：
    苹果 17 温度：<cond>_temp.csv（系统电池温度，0.01℃），按 CSV 的 ts_ms 对齐起跑时刻
    苹果 17 帧率：<cond>_1.csv 的 elapsed_s / fps
    苹果 13 温度：**人工点测**（红外测温枪，背面表面温度），只有 0/5/…/30 七个点
    苹果 13 帧率：<cond>_1.csv 的 elapsed_s / fps

用法：
    python tools/charts/make_ios_timeseries.py
"""
import argparse
import datetime
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

# 颜色按"负载强度"排序，两台机器保持一致，方便并排看
STYLE = {
    'IDLE': ('空场景 60fps',        '#34495e'),
    'GA':   ('GPU 负载',            '#e67e22'),
    'GBR':  ('GPU + 限帧 30→20',    '#8e44ad'),
    'GAH':  ('GPU 12 层',           '#c0392b'),
    'CA':   ('CPU 负载',            '#16a085'),
    'CAH':  ('CPU 1000 立方体',      '#27ae60'),
}

# 苹果 13：人工点测（0/5/10/15/20/25/30 分钟）
T13 = {
    'IDLE': [25.5, 35.1, 37.0, 38.3, 39.3, 40.5, 40.1],
    'GA':   [25.3, 34.8, 38.4, 39.5, 41.2, 41.3, 41.0],
    'CA':   [25.4, 33.0, 35.7, 37.1, 38.0, 38.5, 38.7],
}
MIN13 = [0, 5, 10, 15, 20, 25, 30]


def parse_hms(s):
    p = s.strip().split(':')
    if len(p) != 3:
        return None
    try:
        return int(p[0]) * 3600 + int(p[1]) * 60 + float(p[2])
    except ValueError:
        return None


def read_temp_aligned(temp_path, csv_path):
    """温度日志按 CSV 的起跑时刻对齐，返回 [(分钟, ℃)]"""
    secs = []
    with open(temp_path, encoding='utf-8-sig') as f:
        for line in f:
            parts = line.strip().split(',')
            if len(parts) < 2:
                continue
            s = parse_hms(parts[0])
            if s is None:
                continue
            try:
                secs.append((s, float(parts[1])))
            except ValueError:
                continue
    if not secs:
        return []
    t0 = None
    if csv_path and os.path.exists(csv_path):
        with open(csv_path, encoding='utf-8-sig') as f:
            head = f.readline().strip().split(',')
            if 'ts_ms' in head:
                i = head.index('ts_ms')
                row = f.readline().strip().split(',')
                if len(row) > i:
                    d = datetime.datetime.fromtimestamp(int(row[i]) / 1000.0)
                    t0 = d.hour * 3600 + d.minute * 60 + d.second
    if t0 is None:
        t0 = secs[0][0]
    out = []
    for s, v in secs:
        m = (s - t0) / 60.0
        if -0.5 <= m <= 32:
            out.append((m, v))
    return out


def read_fps(csv_path, step=5):
    """每 step 秒取一个点（默认 5 秒 = 一个采样行），返回 [(分钟, fps)]"""
    out = []
    with open(csv_path, encoding='utf-8-sig') as f:
        head = f.readline().strip().split(',')
        if 'elapsed_s' not in head or 'fps' not in head:
            return []
        ie, iff = head.index('elapsed_s'), head.index('fps')
        n = 0
        for line in f:
            parts = line.strip().split(',')
            if len(parts) <= max(ie, iff):
                continue
            n += 1
            if n % step:
                continue
            try:
                out.append((float(parts[ie]) / 60.0, float(parts[iff])))
            except ValueError:
                continue
    return out


def style_axes(ax, ylabel, title, ylim, ystep):
    ax.set_xlim(0, 31)
    ax.set_ylim(*ylim)
    ax.set_xlabel('起跑后分钟数', fontsize=12)
    ax.set_ylabel(ylabel, fontsize=12)
    ax.set_title(title, fontsize=15, fontweight='bold', pad=14)
    ax.xaxis.set_major_locator(MultipleLocator(5))
    ax.yaxis.set_major_locator(MultipleLocator(ystep))
    ax.grid(True, color='#ecf0f1')
    ax.set_axisbelow(True)
    for s in ('top', 'right'):
        ax.spines[s].set_visible(False)


def draw_temp(variants, out_path, title, note):
    fig, ax = plt.subplots(figsize=(11.5, 6.4), dpi=130)
    ends = []
    for cond, series in variants:
        label, color = STYLE[cond]
        xs = [p[0] for p in series]
        ys = [p[1] for p in series]
        ax.plot(xs, ys, color=color, linewidth=2.6 if cond != 'IDLE' else 2.8,
                marker='o' if len(xs) < 20 else None, markersize=5, label=label)
        if ys:
            ends.append((label, ys[-1], color))
    style_axes(ax, '机身温度 ℃', title, (23, 45), 2)
    ax.legend(loc='lower right', fontsize=11, framealpha=0.95)

    # 终点标签：几轮温度接近时合并成一条，避免标签糊在一起
    ends_sorted = sorted(ends, key=lambda e: -e[1])
    if ends_sorted and (ends_sorted[0][1] - ends_sorted[-1][1]) < 1.0:
        lo, hi = ends_sorted[-1][1], ends_sorted[0][1]
        ax.annotate('%.1f~%.1f℃' % (lo, hi), xy=(30, (lo + hi) / 2), xytext=(30.6, (lo + hi) / 2),
                    fontsize=11, color='#c0392b', va='center', fontweight='bold')
    else:
        for label, y, color in ends_sorted:
            ax.annotate('%.1f℃' % y, xy=(30, y), xytext=(30.6, y),
                        fontsize=10.5, color=color, va='center', fontweight='bold')
    span = max(e[1] for e in ends) - min(e[1] for e in ends) if ends else 0
    ax.text(0.02, 0.96, '全部轮次终点跨度：%.1f℃' % span, transform=ax.transAxes,
            fontsize=12, color='#c0392b', fontweight='bold', va='top')
    fig.text(0.5, 0.035, note, ha='center', fontsize=10, color='#8e44ad')
    fig.text(0.5, 0.008,
             '温控全程关闭 ｜ 30 分钟 ｜ 屏幕亮度 10% ｜ 全程插线',
             ha='center', fontsize=10, color='#555555')
    fig.tight_layout(rect=(0, 0.07, 0.955, 1))
    fig.savefig(out_path)
    print('写出:', out_path, ' 终点跨度 %.1f℃' % span)


def draw_fps(variants, out_path, title, note):
    fig, ax = plt.subplots(figsize=(11.5, 6.4), dpi=130)
    for cond, series in variants:
        label, color = STYLE[cond]
        xs = [p[0] for p in series]
        ys = [p[1] for p in series]
        ax.plot(xs, ys, color=color, linewidth=1.9, alpha=0.95, label=label)
    # 20fps 可玩下限
    ax.axhline(20, color='#7f8c8d', linestyle=':', linewidth=1.8)
    ax.text(17.2, 20.8, '20fps 可玩下限', fontsize=10.5, color='#7f8c8d')
    style_axes(ax, '帧率 fps', title, (0, 66), 10)
    ax.legend(loc='center right', fontsize=11, framealpha=0.95)
    fig.text(0.5, 0.035, note, ha='center', fontsize=10, color='#8e44ad')
    fig.text(0.5, 0.008,
             '温控全程关闭 ｜ 30 分钟 ｜ 屏幕亮度 10% ｜ 全程插线',
             ha='center', fontsize=10, color='#555555')
    fig.tight_layout(rect=(0, 0.07, 1, 1))
    fig.savefig(out_path)
    print('写出:', out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--d17', default=r'C:\Users\Administrator\Desktop\温控一期测试\正式AB实验\实验数据\apple17')
    ap.add_argument('--d13', default=r'C:\Users\Administrator\Desktop\温控一期测试\正式AB实验\实验数据\apple13')
    ap.add_argument('--out', default=r'C:\Users\Administrator\Desktop\温控一期测试\正式AB实验\图_苹果17')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    # ---------- 苹果 13 ----------
    v13_temp = []
    v13_fps = []
    for cond in ('IDLE', 'GA', 'CA'):
        if cond in T13:
            v13_temp.append((cond, list(zip(MIN13, T13[cond]))))
        csv = os.path.join(args.d13, 'iphone13_%s_1.csv' % cond)
        fps = read_fps(csv) if os.path.exists(csv) else []
        if fps:
            v13_fps.append((cond, fps))

    draw_temp(v13_temp, os.path.join(args.out, '03_苹果13_温度随时间.png'),
              '苹果 13 · 三种负载下的机身温度',
              '温度来源：红外测温枪点测（iOS 27 已移除系统温度接口），测点为机身背面贴纸表面')
    draw_fps(v13_fps, os.path.join(args.out, '04_苹果13_帧率随时间.png'),
             '苹果 13 · 同样的三种负载，帧率却在持续崩塌',
             '帧率来源：游戏内 CSV（每 5 秒一个采样行）')

    # ---------- 苹果 17 ----------
    v17_temp = []
    v17_fps = []
    for cond in ('IDLE', 'GA', 'GBR', 'GAH', 'CAH'):
        csv = os.path.join(args.d17, 'iphone17_%s_1.csv' % cond)
        tpath = os.path.join(args.d17, 'iphone17_%s_1_temp.csv' % cond)
        if os.path.exists(tpath):
            tp = read_temp_aligned(tpath, csv if os.path.exists(csv) else None)
            if tp:
                v17_temp.append((cond, tp))
        fps = read_fps(csv) if os.path.exists(csv) else []
        if fps:
            v17_fps.append((cond, fps))

    draw_temp(v17_temp, os.path.join(args.out, '05_苹果17_温度随时间.png'),
              '苹果 17 · 五种负载下的机身温度（几乎完全重合）',
              '温度来源：系统接口读取电池温度（iOS 26，单位 0.01℃）')
    draw_fps(v17_fps, os.path.join(args.out, '06_苹果17_帧率随时间.png'),
             '苹果 17 · 同样的五种负载，帧率却各掉一半以上',
             '帧率来源：游戏内 CSV（每 5 秒一个采样行）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
