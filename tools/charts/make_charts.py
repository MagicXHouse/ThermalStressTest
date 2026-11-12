#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""温控 A/B 实验对比图生成器（纯 Pillow 手绘，无 matplotlib 依赖）。

为什么不用 matplotlib：交付环境通常只装了 Pillow；这里只需要折线 + 柱状，
手绘反而更省依赖，也便于精确控制中文字体与图例排版。

输出（默认 5 张）：
  01_温度_GPU组.png      GA / GB / GB2 温度曲线
  02_温度_CPU组.png      CA / CB / CB2 / CB3 温度曲线
  03_帧率_CPU组.png      CPU 组帧率（看限帧是否生效）
  04_分辨率_CPU组.png    分辨率档位（看升档是否把降档撤回）
  05_温升汇总.png        各轮 ΔT 柱状对比（含 IDLE 底噪）

用法：
  python tools/charts/make_charts.py <实验数据目录> <输出目录>
  例：python tools/charts/make_charts.py 实验数据/redmik30 报告/图

输入约定：
  <数据目录>/<机型>_<条件>_<次>.csv        需含 elapsed_s / fps / shading_scale
  <数据目录>/<机型>_<条件>_<次>_temp.csv   两列：HH:MM:SS.ss,Temperature

新增一条曲线：在 SERIES 里加 (颜色, 图例名)，再把条件码加进对应 chart_*() 的列表
（条件码 = 文件名里 <机型>_ 与 _<次> 之间的部分，如 GA / GB2 / CB3）。

口径：ΔT 取温度日志首末值；与 汇总实验.js 的表格（按 CSV 时长对齐）可能差 0.1℃。

依赖：Pillow；中文字体取 C:/Windows/Fonts/msyh.ttc，缺失时回落 simhei.ttf。
"""
import csv
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1160, 640
ML, MR, MT, MB = 96, 300, 104, 104
FONT = 'C:/Windows/Fonts/msyh.ttc'
FONT_BD = 'C:/Windows/Fonts/msyhbd.ttc'

SERIES = {
    'GA': ('#c0392b', 'GA 温控关（基线）'),
    'GB': ('#e67e22', 'GB 只降分辨率'),
    'GB2': ('#8e44ad', 'GB2 分辨率+限帧20'),
    'GBx': ('#95a5a6', 'GBx 旧包四档'),
    'GBF': ('#16a085', 'GBF 只降分辨率+FSR关'),
    'CA': ('#c0392b', 'CA 温控关（基线）'),
    'CB': ('#2980b9', 'CB 只降帧率'),
    'CB2': ('#8e44ad', 'CB2 两杠杆'),
    'CB3': ('#27ae60', 'CB3 两杠杆+自动升档'),
    'IDLE': ('#7f8c8d', 'IDLE 空转'),
}


def font(size, bold=False):
    try:
        return ImageFont.truetype(FONT_BD if bold else FONT, size)
    except OSError:
        return ImageFont.truetype('C:/Windows/Fonts/simhei.ttf', size)


def parse_hms(s):
    """温度日志的时间列是 HH:MM:SS.ss（墙钟），不是 epoch 毫秒。"""
    parts = s.strip().split(':')
    if len(parts) != 3:
        return None
    try:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        return None


def read_temp(path):
    pts = []
    with open(path, encoding='utf-8-sig') as f:
        for row in csv.reader(f):
            if len(row) < 2 or not row[0].strip():
                continue
            t = parse_hms(row[0])
            if t is None:
                continue                      # 跳过表头 Time,Temperature
            try:
                v = float(row[1])
            except ValueError:
                continue
            pts.append((t, v))
    if not pts:
        return []
    t0 = pts[0][0]
    out = []
    for t, v in pts:
        e = t - t0
        if e < -3600:                         # 跨零点
            e += 86400
        out.append((e, v))
    return out


def read_csv_cols(path, cols):
    out = {c: [] for c in cols}
    with open(path, encoding='utf-8-sig') as f:
        rd = csv.DictReader(f)
        for row in rd:
            try:
                for c in cols:
                    out[c].append(float(row[c]))
            except (TypeError, ValueError):
                continue
    return out


def moving_avg(vals, win=5):
    out = []
    for i in range(len(vals)):
        a = max(0, i - win + 1)
        chunk = vals[a:i + 1]
        out.append(sum(chunk) / len(chunk))
    return out


def downsample(pts, maxn=400):
    if len(pts) <= maxn:
        return pts
    step = len(pts) / float(maxn)
    return [pts[int(i * step)] for i in range(maxn)] + [pts[-1]]


def nice_range(vmin, vmax, pad=0.08):
    if vmax == vmin:
        vmax = vmin + 1
    d = (vmax - vmin) * pad
    return vmin - d, vmax + d


def draw_axes(d, title, subtitle, xmax, ymin, ymax, xticks, yticks, notes):
    d.rectangle([ML, MT, W - MR, H - MB], outline=(210, 210, 210))
    # 网格 + 刻度
    for tv, ty in yticks:
        y = H - MB - (ty - ymin) / (ymax - ymin) * (H - MB - MT)
        d.line([ML, y, W - MR, y], fill=(238, 238, 238))
        lab = tv if isinstance(tv, str) else f'{tv:g}'
        d.text((ML - 10, y), lab, font=font(15), fill=(90, 90, 90), anchor='rm')
    for tv in xticks:
        x = ML + (tv / xmax) * (W - MR - ML)
        d.line([x, MT, x, H - MB], fill=(245, 245, 245))
        d.text((x, H - MB + 8), f'{tv:g}', font=font(15), fill=(90, 90, 90), anchor='ma')
    d.text((ML, 26), title, font=font(25, True), fill=(30, 30, 30))
    d.text((ML, 60), subtitle, font=font(15), fill=(120, 120, 120))
    d.text(((ML + W - MR) / 2, H - 60), '时间（分钟）', font=font(16), fill=(80, 80, 80), anchor='ma')
    if notes:
        d.text((ML, H - 30), notes, font=font(13), fill=(150, 150, 150), anchor='la')


def plot_series(d, pts, xmax, ymin, ymax, color, width=2):
    xy = []
    for t, v in downsample(pts):
        if v is None:
            continue
        x = ML + (min(t / 60.0, xmax) / xmax) * (W - MR - ML)
        y = H - MB - (v - ymin) / (ymax - ymin) * (H - MB - MT)
        xy.append((x, y))
    if len(xy) > 1:
        d.line(xy, fill=color, width=width, joint='curve')


def legend_block(d, entries, title):
    x = W - MR + 18
    y = MT + 6
    d.text((x, y - 26), title, font=font(16, True), fill=(60, 60, 60))
    for color, label, detail in entries:
        d.line([x, y + 9, x + 26, y + 9], fill=color, width=3)
        d.text((x + 34, y), label, font=font(15), fill=(40, 40, 40))
        if detail:
            d.text((x + 34, y + 20), detail, font=font(13), fill=(120, 120, 120))
        y += 46


def new_canvas():
    img = Image.new('RGB', (W, H), 'white')
    return img, ImageDraw.Draw(img)


def save(img, outdir, name):
    os.makedirs(outdir, exist_ok=True)
    p = os.path.join(outdir, name)
    img.save(p)
    print('  写出', p)


def chart_temp(datadir, outdir, fname, title, subtitle, conds, note):
    series = []
    for c in conds:
        p = os.path.join(datadir, f'redmik30_{c}_1_temp.csv')
        if not os.path.exists(p):
            print('  跳过（缺文件）', p)
            continue
        pts = read_temp(p)
        if not pts:
            continue
        start = pts[0][1]
        end = pts[-1][1]
        series.append((c, pts, start, end))
    if not series:
        return
    xmax = max(t for _, pts, _, _ in series for t, _ in pts) / 60.0
    xmax = max(5, round(xmax + 0.5))
    ymin = min(v for _, pts, _, _ in series for _, v in pts)
    ymax = max(v for _, pts, _, _ in series for _, v in pts)
    ymin, ymax = nice_range(ymin - 0.5, ymax + 0.5)
    xticks = list(range(0, int(xmax) + 1, 5))
    ymin_i, ymax_i = int(ymin), int(ymax) + 1
    yticks = [(v, v) for v in range(ymin_i, ymax_i + 1, 2)]
    img, d = new_canvas()
    draw_axes(d, title, subtitle, xmax, ymin, ymax, xticks, yticks, note)
    entries = []
    for c, pts, start, end in series:
        color, label = SERIES[c]
        plot_series(d, pts, xmax, ymin, ymax, color)
        entries.append((color, label, f'{start:.1f} → {end:.1f}℃  (ΔT {end - start:+.1f})'))
    legend_block(d, entries, '图例 / 起止温度')
    save(img, outdir, fname)


def chart_fps(datadir, outdir, fname, title, subtitle, conds, note):
    series = []
    for c in conds:
        p = os.path.join(datadir, f'redmik30_{c}_1.csv')
        if not os.path.exists(p):
            continue
        d2 = read_csv_cols(p, ['elapsed_s', 'fps'])
        pts = list(zip(d2['elapsed_s'], moving_avg(d2['fps'])))
        if pts:
            series.append((c, pts, sum(d2['fps']) / len(d2['fps'])))
    if not series:
        return
    xmax = max(t for _, pts, _ in series for t, _ in pts) / 60.0
    xmax = max(5, round(xmax + 0.5))
    ymax = 65.0
    img, d = new_canvas()
    yticks = [(v, v) for v in range(0, 71, 10)]
    draw_axes(d, title, subtitle, xmax, 0, ymax, list(range(0, int(xmax) + 1, 5)), yticks, note)
    entries = []
    for c, pts, avg in series:
        color, label = SERIES[c]
        plot_series(d, pts, xmax, 0, ymax, color)
        entries.append((color, label, f'平均 {avg:.1f} fps'))
    legend_block(d, entries, '图例 / 平均帧率')
    save(img, outdir, fname)


def chart_scale(datadir, outdir, fname, title, subtitle, conds, note):
    series = []
    for c in conds:
        p = os.path.join(datadir, f'redmik30_{c}_1.csv')
        if not os.path.exists(p):
            continue
        d2 = read_csv_cols(p, ['elapsed_s', 'shading_scale'])
        pts = list(zip(d2['elapsed_s'], d2['shading_scale']))
        if pts:
            series.append((c, pts, pts[-1][1]))
    if not series:
        return
    xmax = max(t for _, pts, _ in series for t, _ in pts) / 60.0
    xmax = max(5, round(xmax + 0.5))
    img, d = new_canvas()
    yticks = [(f'{v}%', v / 100.0) for v in (60, 70, 80, 90, 100)]
    draw_axes(d, title, subtitle, xmax, 0.55, 1.05, list(range(0, int(xmax) + 1, 5)), yticks, note)
    entries = []
    for c, pts, last in series:
        color, label = SERIES[c]
        plot_series(d, pts, xmax, 0.55, 1.05, color, width=3)
        entries.append((color, label, f'结束档位 {last:.2f}'))
    legend_block(d, entries, '图例 / 结束档位')
    save(img, outdir, fname)


def chart_summary(datadir, outdir, fname, rows, note):
    """rows: [(cond, deltaT, group)]"""
    img, d = new_canvas()
    left, right = 90, W - 60
    top, bottom = MT + 10, H - MB - 30
    vmax = max(r[1] for r in rows) * 1.25
    d.line([left, bottom, right, bottom], fill=(180, 180, 180))
    bw = (right - left) / float(len(rows))
    for v in range(0, int(vmax) + 1, 2):
        y = bottom - v / vmax * (bottom - top)
        d.line([left, y, right, y], fill=(240, 240, 240))
        d.text((left - 10, y), f'{v}℃', font=font(14), fill=(110, 110, 110), anchor='rm')
    for i, (cond, dt, group) in enumerate(rows):
        color, _ = SERIES.get(cond, ('#34495e', ''))
        x0 = left + i * bw + bw * 0.22
        x1 = left + (i + 1) * bw - bw * 0.22
        y = bottom - dt / vmax * (bottom - top)
        d.rectangle([x0, y, x1, bottom], fill=color)
        d.text(((x0 + x1) / 2, y - 8), f'+{dt:.1f}', font=font(15, True), fill=(50, 50, 50), anchor='mb')
        d.text(((x0 + x1) / 2, bottom + 8), cond, font=font(15), fill=(60, 60, 60), anchor='ma')
        d.text(((x0 + x1) / 2, bottom + 28), group, font=font(12), fill=(150, 150, 150), anchor='ma')
    d.text((left, 26), '温升 ΔT 汇总（红米 K30，30 分钟/轮）', font=font(25, True), fill=(30, 30, 30))
    d.text((left, 60), '柱高 = 结束温度 − 起始温度；GA/CA 是各自负载组的基线', font=font(15), fill=(120, 120, 120))
    d.text((left, H - 30), note, font=font(13), fill=(150, 150, 150))
    save(img, outdir, fname)


def main():
    datadir = sys.argv[1] if len(sys.argv) > 1 else '实验数据/redmik30'
    outdir = sys.argv[2] if len(sys.argv) > 2 else '报告/图'
    print('数据目录:', datadir)

    chart_temp(datadir, outdir, '01_温度_GPU组.png',
               'GPU 负载（3 层平面）：温度走势',
               '同负载、同 30 分钟，温控关 vs 只降分辨率 vs 加限帧',
               ['GA', 'GB', 'GB2'],
               '起点都在 25~27℃；GA 与 GB 几乎重合 —— 只降分辨率没有降温（ΔT 取温度日志首末值，与汇总表可能差 0.1℃）')

    chart_temp(datadir, outdir, '02_温度_CPU组.png',
               'CPU 负载（1500 立方体）：温度走势',
               '温控关 / 只降帧率 / 两杠杆 / 两杠杆+自动升档',
               ['CA', 'CB', 'CB2', 'CB3'],
               'CB3（绿）最低：分辨率被自动撤回、只留限帧，温升 +8.3℃（ΔT 取温度日志首末值，与汇总表可能差 0.1℃）')

    chart_fps(datadir, outdir, '03_帧率_CPU组.png',
              'CPU 负载：帧率走势（5 点滑动平均）',
              '限帧把 39.6fps 压到 ~29fps，是降温的来源',
              ['CA', 'CB', 'CB3'],
              'CB 与 CB3 都停在 30fps 档；CB2 同时降了分辨率，帧率与它相近但画质更差')

    chart_scale(datadir, outdir, '04_分辨率_CPU组.png',
                'CPU 负载：分辨率档位走势',
                'CB2（紫）一直停在 0.70；CB3（绿）被自动升档拉回 1.00',
                ['CB2', 'CB3'],
                'CPU 瓶颈下降分辨率对帧率无益；CB3 的自动升档在第 85~100 秒把它撤回 1.00')

    chart_summary(datadir, outdir, '05_温升汇总.png',
                  [('GA', 14.4, 'GPU'), ('GB', 14.3, 'GPU'), ('GB2', 12.4, 'GPU'),
                   ('CA', 10.1, 'CPU'), ('CB', 9.0, 'CPU'), ('CB2', 9.9, 'CPU'), ('CB3', 8.3, 'CPU'),
                   ('IDLE', 6.6, '空转')],
                  'IDLE 6.6℃ 是屏幕+微信+系统的底噪，占 GPU 组温升的 46%、CPU 组的 65%')

    print('完成')


if __name__ == '__main__':
    main()
