import csv, numpy as np

# ============ 路径配置（换设备/机器时只改这里） ============
BASE_CSV  = r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_A\thermal_A.csv'   # 温控关（baseline）
THERM_CSV = r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_B\thermal_B.csv'   # 温控开
BASE_TEMP  = r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_A\temp_log.csv'
THERM_TEMP = r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_B\temp_log.csv'

# ============ 判定阈值（对齐方案 4.5，需实测标定） ============
# 方案 4.5 的合入标准只有三条量化门槛 + 主观项：
#   1) 平均温度下降（核心）
#   2) 掉帧率下降
#   3) 帧率标准差下降
# 平均帧率 / p95 帧时间在"降帧率杠杆"下天然恶化，方案明确写了"仅参考"，所以这里只打印不判定。
TEMP_DROP_MIN = 0.0     # 平均温度至少下降这么多 ℃ 才算"下降"（噪声余量，实测后调）
STD_DROP_MIN  = 0.0     # 帧率标准差至少下降这么多 FPS


def _num(s):
    """把 CSV 单元格转成 float；'NA'/空/非法一律 NaN（battery_pct 在非微信环境就是 NA）。"""
    try:
        return float(s)
    except (TypeError, ValueError):
        return float('nan')


def load(path):
    rows = list(csv.DictReader(open(path, encoding='utf-8-sig')))
    fields = set(rows[0].keys())

    def col(k):
        if k not in fields:
            return None
        return np.array([_num(x.get(k)) for x in rows])

    return dict(
        fps=col('fps'), ft=col('ft_avg_ms'), p95=col('ft_p95_ms'),
        jank=col('jank_gt_2x'), fps_std=col('fps_std'),
        # T04：drop_rate 的预算冻结在采样起点，温控把目标帧率降到 30 后它会恒 ~100%，
        # 不能用来判"掉帧率有没有下降"。drop_rate_cur 用当前 game.frameRate 做预算，才是这个判据。
        drop=col('drop_rate'), drop_cur=col('drop_rate_cur'),
        scale=col('shading_scale'), fr=col('frame_rate'), bat=col('battery_pct'),
        el=col('elapsed_s'), ts=col('ts_ms'),
    )


def load_temp(path):
    rows = list(csv.reader(open(path, encoding='utf-8-sig')))
    return np.array([float(x[1]) for x in rows[1:] if len(x) > 1 and x[1].strip()])


def nmean(a):
    return float(np.nanmean(a)) if a is not None and len(a) else float('nan')


BASE = load(BASE_CSV); THERM = load(THERM_CSV)
BT = load_temp(BASE_TEMP); TT = load_temp(THERM_TEMP)

# ============ 每场景概览 ============
for name, d, t in [('baseline(温控关)', BASE, BT), ('thermal(温控开)', THERM, TT)]:
    print('--- %s ---' % name)
    print('  frames %d  dur_s %.0f' % (len(d['fps']), d['el'][-1]))
    print('  fps   mean/std/min/max  %.2f / %.2f / %.2f / %.2f'
          % (nmean(d['fps']), np.nanstd(d['fps']), np.nanmin(d['fps']), np.nanmax(d['fps'])))
    print('  ft_avg_ms mean %.2f  p95(窗口均值) %.2f' % (nmean(d['ft']), nmean(d['p95'])))
    if d['fps_std'] is not None:
        print('  fps_std(窗口均值) %.2f' % nmean(d['fps_std']))
    if d['drop'] is not None:
        print('  drop_rate(固定预算, 跨阶段可比) %.2f%%' % nmean(d['drop']))
    if d['drop_cur'] is not None:
        print('  drop_rate_cur(当前目标帧率)     %.2f%%' % nmean(d['drop_cur']))
    else:
        print('  drop_rate_cur 缺失（旧版 14 列 CSV）')
    print('  jank(>2x预算) sum %d' % np.nansum(d['jank']))
    print('  temp start/end/mean/max %.1f / %.1f / %.1f / %.1f'
          % (t[0], t[-1], t.mean(), t.max()))
    print('  scale_uniq %s  fr_uniq %s' % (np.unique(d['scale']), np.unique(d['fr'])))

# ============ 温控前后达标判定（对齐方案 4.5） ============
print('--- 达标判定（方案 4.5：温度 / 掉帧率 / 帧率标准差） ---')
checks = []

# 1) 平均温度下降（方案写的是"核心依据"，必须进判定）
temp_drop = BT.mean() - TT.mean()
checks.append(('平均温度下降 (Δ=%.2f℃)' % temp_drop, temp_drop > TEMP_DROP_MIN))
print('  temp  %.2f -> %.2f ℃' % (BT.mean(), TT.mean()))

# 2) 掉帧率下降：优先用当前目标帧率口径的 drop_rate_cur
use_cur = BASE['drop_cur'] is not None and THERM['drop_cur'] is not None
drop_base = nmean(BASE['drop_cur'] if use_cur else BASE['drop'])
drop_therm = nmean(THERM['drop_cur'] if use_cur else THERM['drop'])
src = 'drop_rate_cur' if use_cur else 'drop_rate'
if np.isnan(drop_base) or np.isnan(drop_therm):
    checks.append(('掉帧率下降（数据缺失）', False))
else:
    checks.append(('掉帧率下降 [%s]' % src, drop_therm < drop_base))
print('  drop  %.2f%% -> %.2f%%  (口径: %s)' % (drop_base, drop_therm, src))
if not use_cur:
    print('  ⚠ 该 CSV 没有 drop_rate_cur 列（旧版 14 列），只能用固定预算的 drop_rate 判；')
    print('    温控降帧率后这一列会虚高，结论可能误判为"掉帧率暴涨"，请用新版构建重跑。')

# 3) 帧率标准差下降
if BASE['fps_std'] is not None and THERM['fps_std'] is not None:
    std_base = nmean(BASE['fps_std']); std_therm = nmean(THERM['fps_std'])
    checks.append(('帧率标准差下降 (%.2f -> %.2f)' % (std_base, std_therm),
                   (std_therm - std_base) < -STD_DROP_MIN))
    print('  fps_std  %.2f -> %.2f' % (std_base, std_therm))
else:
    checks.append(('帧率标准差下降（数据缺失）', False))

# ---- 以下按方案 4.5 只做参考，不参与判定 ----
print('  [参考] fps   %.2f -> %.2f（降帧率杠杆下天然下降，不作门槛）'
      % (nmean(BASE['fps']), nmean(THERM['fps'])))
if BASE['p95'] is not None and THERM['p95'] is not None:
    b95, t95 = nmean(BASE['p95']), nmean(THERM['p95'])
    print('  [参考] p95   %.2f -> %.2f ms (改善 %.1f%%)（仅参考）'
          % (b95, t95, (b95 - t95) / b95 * 100 if b95 else float('nan')))
    print('  [参考] jank  %d -> %d' % (np.nansum(BASE['jank']), np.nansum(THERM['jank'])))

for label, ok in checks:
    print('  [%s] %s' % ('PASS' if ok else 'FAIL', label))
print('  达标：%s' % ('是' if all(ok for _, ok in checks) else '否'))
print('  说明：无崩溃/无黑屏/画质可接受属主观项，需人工签字确认。')
