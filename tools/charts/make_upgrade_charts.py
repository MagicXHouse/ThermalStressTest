#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""升档实验（UP-A / UP-B / UP-C）图表：帧率、分辨率、温度 —— 各画一张。

复用 make_charts.py 的字体与数据读取。
自动扫描 <数据目录>/oppopad_UPA_1.csv 等，有几轮画几条线。

用法：python tools/charts/make_upgrade_charts.py <实验数据目录> <输出目录>
"""
import os
import sys
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_charts as mc
from PIL import Image, ImageDraw

W, H = 1160, 640
ML, MR, MT, MB = 96, 300, 120, 104

CONDS = [
    ('UPA', '#c0392b', '#f0d4d0', 'UP-A 温控关（基准）'),
    ('UPB', '#2980b9', '#d6e4f5', 'UP-B 升档关'),
    ('UPC', '#27ae60', '#d5efe0', 'UP-C 升档开'),
]
UNLOAD_S = 900.0


def sec_of_day_from_ms(ms):
    dt = datetime.datetime.fromtimestamp(ms / 1000.0)
    return dt.hour * 3600 + dt.minute * 60 + dt.second + dt.microsecond / 1e6


def load_series(datadir):
    out = []
    for cond, color, light, label in CONDS:
        csv_path = os.path.join(datadir, f'oppopad_{cond}_1.csv')
        if not os.path.exists(csv_path):
            continue
        cols = mc.read_csv_cols(csv_path, ['elapsed_s', 'fps', 'shading_scale', 'load_gpu_layers'])
        el = cols['elapsed_s']
        layers = cols['load_gpu_layers']

        unload = UNLOAD_S
        for i in range(1, len(layers)):
            if layers[i] < layers[i - 1]:
                unload = el[i]

        temp_pts = []
        tmp_path = os.path.join(datadir, f'oppopad_{cond}_1_temp.csv')
        ts = mc.read_csv_cols(csv_path, ['ts_ms']).get('ts_ms') or []
        if os.path.exists(tmp_path) and len(ts) >= 2:
            pts = mc.read_temp(tmp_path)
            csv0 = sec_of_day_from_ms(ts[0])
            temp0 = None
            with open(tmp_path, encoding='utf-8-sig') as f:
                for line in f:
                    parts = line.strip().split(',')
                    if len(parts) >= 2:
                        s = mc.parse_hms(parts[0])
                        if s is not None:
                            temp0 = s
                            break
            if temp0 is not None:
                temp_pts = [(t + (temp0 - csv0), v) for t, v in pts]

        out.append(dict(cond=cond, color=color, light=light, label=label,
                        fps=list(zip(el, cols['fps'])),
                        fps_s=list(zip(el, mc.moving_avg(cols['fps'], 31))),
                        scale=list(zip(el, cols['shading_scale'])),
                        temp=temp_pts, unload=unload))
    return out


# ---------- 画布与坐标 ----------
def canvas():
    img = Image.new('RGB', (W, H), 'white')
    return img, ImageDraw.Draw(img)


def px(t, xmax_min):
    return ML + (min(t / 60.0, xmax_min) / xmax_min) * (W - MR - ML)


def py(v, vmin, vmax):
    return H - MB - (v - vmin) / (vmax - vmin) * (H - MB - MT)


def axes(d, xmax_min, vmin, vmax, vticks, title, subtitle, ylabel, notes, vfmt='{:g}'):
    d.rectangle([ML, MT, W - MR, H - MB], outline=(212, 212, 212))
    for tv in vticks:
        y = py(tv, vmin, vmax)
        d.line([ML, y, W - MR, y], fill=(238, 238, 238))
        d.text((ML - 10, y), vfmt.format(tv), font=mc.font(15), fill=(90, 90, 90), anchor='rm')
    for tv in range(0, int(xmax_min) + 1, 5):
        x = px(tv * 60.0, xmax_min)
        d.line([x, MT, x, H - MB], fill=(245, 245, 245))
        d.text((x, H - MB + 8), f'{tv}', font=mc.font(15), fill=(90, 90, 90), anchor='ma')
    d.text((ML, 30), title, font=mc.font(25, True), fill=(30, 30, 30))
    d.text((ML, 64), subtitle, font=mc.font(15), fill=(120, 120, 120))
    d.text((ML - 10, MT - 16), ylabel, font=mc.font(14, True), fill=(120, 120, 120), anchor='lb')
    d.text(((ML + W - MR) / 2, H - 58), '时间（分钟）', font=mc.font(16), fill=(80, 80, 80), anchor='ma')
    if notes:
        d.text((ML, H - 28), notes, font=mc.font(12), fill=(150, 150, 150), anchor='la')


def curve(d, pts, xmax_min, vmin, vmax, color, width=3, maxn=700):
    xy = [(px(t, xmax_min), py(v, vmin, vmax)) for t, v in mc.downsample(pts, maxn)]
    if len(xy) > 1:
        d.line(xy, fill=color, width=width, joint='curve')


def vline(d, t, xmax_min, label):
    x = px(t, xmax_min)
    for y in range(MT, H - MB, 12):
        d.line([x, y, x, min(y + 6, H - MB)], fill=(150, 150, 150), width=2)
    d.text((x + 6, MT + 4), label, font=mc.font(14, True), fill=(110, 110, 110))


def legend(d, entries, title):
    x = W - MR + 18
    y = MT + 4
    d.text((x, y - 26), title, font=mc.font(16, True), fill=(60, 60, 60))
    for color, label, detail in entries:
        d.line([x, y + 9, x + 24, y + 9], fill=color, width=3)
        d.text((x + 32, y), label, font=mc.font(15), fill=(40, 40, 40))
        if detail:
            d.text((x + 32, y + 19), detail, font=mc.font(13), fill=(125, 125, 125))
        y += 46


def xmax_of(series, key):
    m = 30.0
    for s in series:
        if s[key]:
            m = max(m, s[key][-1][0] / 60.0)
    return float(int(m + 0.999))


# ---------- 图 A：帧率 ----------
def chart_fps(series, outdir, name='07_升档实验_帧率.png'):
    xmax_min = xmax_of(series, 'fps')
    img, d = canvas()
    axes(d, xmax_min, 0, 70, [0, 10, 20, 30, 40, 50, 60, 70],
         '升档实验 · 帧率',
         ('满载平面 10 层 → 达标后撤载到 3 层（' +
          (f'{min(s["unload"] for s in series)/60.0:.1f}' if len({round(s["unload"]) for s in series}) == 1
           else f'{min(s["unload"] for s in series)/60.0:.1f}~{max(s["unload"] for s in series)/60.0:.1f}') +
          ' 分钟撤载）') if series else '满载 → 撤载',
         'fps',
         '浅色=原始 fps（帧时间卡在 16.7/33.3ms 之间时会锯齿，属正常）；粗线=约 155 秒滑动平均；灰竖线=撤载时刻')
    for s in series:
        if s['fps']:
            curve(d, s['fps'], xmax_min, 0, 70, s['light'], width=1, maxn=900)
            curve(d, s['fps_s'], xmax_min, 0, 70, s['color'], width=3)
    if series:
        us = [s['unload'] for s in series]
        lab = (f"撤载 {min(us)/60.0:.1f}min" if max(us) - min(us) < 30
               else f"撤载 {min(us)/60.0:.1f}~{max(us)/60.0:.1f}min")
        vline(d, sum(us)/len(us), xmax_min, lab)

    entries = []
    for s in series:
        if not s['fps_s']:
            continue
        cut = s['unload']
        head = [v for t, v in s['fps'] if t < cut]
        tail = [v for t, v in s['fps'] if t > cut]
        h = sum(head) / len(head) if head else float('nan')
        ta = sum(tail) / len(tail) if tail else float('nan')
        entries.append((s['color'], s['label'], f'满载 {h:.1f} → 撤载 {ta:.1f} fps'))
    legend(d, entries, '帧率（fps）')
    mc.save(img, outdir, name)


# ---------- 图 B：分辨率 ----------
def chart_scale(series, outdir, name='08_升档实验_分辨率.png'):
    xmax_min = xmax_of(series, 'scale')
    img, d = canvas()
    axes(d, xmax_min, 0.60, 1.05, [0.70, 0.85, 1.00],
         '升档实验 · 分辨率',
         '温控有没有动分辨率（平直 = 没动）',
         'scale',
         '灰竖线=撤载时刻；纵轴 0.60~1.05，标线为 0.70（地板）/ 0.85（中间档）/ 1.00（原生）',
         vfmt='{:.2f}')
    for s in series:
        if s['scale']:
            curve(d, s['scale'], xmax_min, 0.60, 1.05, s['color'], width=3, maxn=400)
            last = s['scale'][-1][1]
            x = px(s['scale'][-1][0], xmax_min)
            d.ellipse([x - 4, py(last, 0.60, 1.05) - 4, x + 4, py(last, 0.60, 1.05) + 4], fill=s['color'])
        vline(d, s['unload'], xmax_min, f"撤载 {s['unload']/60.0:.1f}min")

    entries = []
    for s in series:
        if not s['scale']:
            continue
        vals = sorted(set(v for _, v in s['scale']))
        txt = ' / '.join(f'{v:.2f}' for v in vals)
        entries.append((s['color'], s['label'], f'落点 {txt}'))
    legend(d, entries, '分辨率（scale）')
    mc.save(img, outdir, name)


# ---------- 图 C：温度 ----------
def chart_temp(series, outdir, name='09_升档实验_温度.png'):
    allv = [v for s in series for _, v in s['temp']]
    if not allv:
        print('  跳过温度图（没有温度数据）')
        return
    xmax_min = xmax_of(series, 'temp')
    lo, hi = min(allv), max(allv)
    ymin, ymax = float(int(lo - 1)), float(int(hi + 2))
    img, d = canvas()
    axes(d, xmax_min, ymin, ymax, list(range(int(ymin), int(ymax) + 1, 2)),
         '升档实验 · 机身温度',
         '满载 → 达标后撤载；温度峰值滞后于撤载时刻（热惯性）',
         '温度（℃）',
         '灰竖线=撤载时刻；圆点=该轮峰值')
    for s in series:
        if not s['temp']:
            continue
        curve(d, s['temp'], xmax_min, ymin, ymax, s['color'], width=3, maxn=600)
        pk = max(s['temp'], key=lambda p: p[1])
        x, y = px(pk[0], xmax_min), py(pk[1], ymin, ymax)
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=s['color'])
        d.text((x - 10, y - 22), f'{pk[1]:.1f}℃', font=mc.font(14, True), fill=s['color'], anchor='rm')
    if series:
        us = [s['unload'] for s in series]
        lab = (f"撤载 {min(us)/60.0:.1f}min" if max(us) - min(us) < 30
               else f"撤载 {min(us)/60.0:.1f}~{max(us)/60.0:.1f}min")
        vline(d, sum(us)/len(us), xmax_min, lab)

    entries = []
    for s in series:
        if not s['temp']:
            continue
        first, last = s['temp'][0][1], s['temp'][-1][1]
        pk = max(v for _, v in s['temp'])
        entries.append((s['color'], s['label'], f'ΔT +{last-first:.1f}℃ / 峰值 {pk:.1f}℃'))
    legend(d, entries, '温度（℃）')
    mc.save(img, outdir, name)


def main():
    datadir = sys.argv[1] if len(sys.argv) > 1 else '实验数据/oppopad'
    outdir = sys.argv[2] if len(sys.argv) > 2 else '报告/图'
    print('数据目录:', datadir)
    series = load_series(datadir)
    if not series:
        print('没找到 UP-A/B/C 的 CSV；先跑一轮或检查文件名（oppopad_UPA_1.csv …）')
        return
    onlyCond = sys.argv[3].upper() if len(sys.argv) > 3 else None
    if onlyCond:
        series = [s for s in series if s['cond'] == onlyCond]
        if not series:
            print('没有 ' + onlyCond + ' 的数据')
            return
        label = onlyCond.replace('UPA', 'UP-A').replace('UPB', 'UP-B').replace('UPC', 'UP-C')
        chart_fps(series, outdir, f'{label}_帧率.png')
        chart_scale(series, outdir, f'{label}_分辨率.png')
        chart_temp(series, outdir, f'{label}_温度.png')
    else:
        print('找到:', ', '.join(s['cond'] for s in series))
        chart_fps(series, outdir)
        chart_scale(series, outdir)
        chart_temp(series, outdir)
    print('完成')


if __name__ == '__main__':
    main()
