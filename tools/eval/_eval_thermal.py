import csv, os, sys
import numpy as np

# ============ 路径配置 ============
# 换设备/机器时：改这里的默认值，或者用环境变量覆盖（推荐，避免把机器相关路径提交进仓库）
#   set THERMAL_BASE_CSV=...\thermal_A.csv
#   set THERMAL_THERM_CSV=...\thermal_B.csv
#   set THERMAL_BASE_TEMP=...\temp_log.csv
#   set THERMAL_THERM_TEMP=...\temp_log.csv
BASE_CSV = os.environ.get('THERMAL_BASE_CSV', r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_A\thermal_A.csv')   # 温控关（baseline）
THERM_CSV = os.environ.get('THERMAL_THERM_CSV', r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_B\thermal_B.csv')  # 温控开
BASE_TEMP = os.environ.get('THERMAL_BASE_TEMP', r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_A\temp_log.csv')
THERM_TEMP = os.environ.get('THERMAL_THERM_TEMP', r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_B\temp_log.csv')

# ============ 判定阈值（对齐方案 4.5，需实测标定） ============
# 方案 4.5 的合入标准只有三条量化门槛 + 主观项：
#   1) 平均温度下降（核心）
#   2) 掉帧率下降
#   3) 帧率标准差下降
# 平均帧率 / p95 帧时间在"降帧率杠杆"下天然恶化，方案明确写了"仅参考"，所以这里只打印不判定。
TEMP_DROP_MIN = 0.0     # 平均温度至少下降这么多 ℃ 才算"下降"（噪声余量，实测后调）
STD_DROP_MIN = 0.0      # 帧率标准差至少下降这么多 FPS

# 温度对比的稳态窗口：取最后 N 分钟（不足则取后半段）。
# 为什么必须取稳态：温度是饱和曲线，前 5 分钟升温快、权重高，
# "谁的起始温度低"比"谁的温控好"更能影响整段均值 → 整段均值相减会系统性误判。
STEADY_MINUTES = 15
ROW_SECONDS = 5          # 性能 CSV 每 5s 一行


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
        layer=col('load_gpu_layers'), spawn=col('spawn_count'),
        el=col('elapsed_s'), ts=col('ts_ms'),
        fields=fields,
    )


def load_temp(path):
    rows = list(csv.reader(open(path, encoding='utf-8-sig')))
    return np.array([float(x[1]) for x in rows[1:] if len(x) > 1 and x[1].strip()])


def nmean(a):
    return float(np.nanmean(a)) if a is not None and len(a) else float('nan')


def steady_len(n):
    """稳态窗口的行数：最后 STEADY_MINUTES 分钟；数据不足半程时退化为后半段。"""
    want = int(STEADY_MINUTES * 60 / ROW_SECONDS)
    return max(1, min(want, max(1, n // 2)))


def steady(a):
    """取数组的稳态窗口（最后一段）。"""
    if a is None or len(a) == 0:
        return a
    return a[-steady_len(len(a)):]


def unique_vals(a):
    """某一列去重后的有效值（忽略 NaN）。用于校验两轮负载是否一致。"""
    if a is None:
        return None
    v = a[~np.isnan(a)]
    return np.unique(np.round(v, 3))


def load_consistency(d):
    """返回 (是否同构, 描述)。同构 = 该轮自身层数/立方体数全程不变。"""
    parts = []
    for key, name in (('layer', 'layer'), ('spawn', 'spawn')):
        u = unique_vals(d[key])
        if u is None:
            parts.append('%s=缺列' % name)
            continue
        if len(u) > 1:
            return False, '%s 轮内变化 %s（负载中途改过，数据不可比）' % (name, u.tolist())
        parts.append('%s=%s' % (name, u[0] if len(u) else 'NA'))
    return True, ' '.join(parts)


BASE = load(BASE_CSV)
THERM = load(THERM_CSV)
BT = load_temp(BASE_TEMP)
TT = load_temp(THERM_TEMP)

print('--- 数据来源 ---')
for label, p in (('base csv', BASE_CSV), ('therm csv', THERM_CSV), ('base temp', BASE_TEMP), ('therm temp', THERM_TEMP)):
    print('  %-10s %s  %s' % (label, p, '(缺失)' if not os.path.exists(p) else ''))

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
        print('  drop_rate(固定预算, 5%% 容差) %.2f%%' % nmean(d['drop']))
    if d['drop_cur'] is not None:
        print('  drop_rate_cur(当前目标帧率, 5%% 容差) %.2f%%' % nmean(d['drop_cur']))
    else:
        print('  drop_rate_cur 缺失（旧版 14 列 CSV）')
    print('  jank(>2x预算) sum %d' % np.nansum(d['jank']))
    print('  temp start/end/mean/max %.1f / %.1f / %.1f / %.1f'
          % (t[0], t[-1], t.mean(), t.max()))
    print('  scale_uniq %s  fr_uniq %s' % (np.unique(d['scale']), np.unique(d['fr'])))
    print('  load: %s' % (load_consistency(d)[1],))

# ============ 温控前后达标判定（对齐方案 4.5） ============
print('--- 达标判定（方案 4.5：温度 / 掉帧率 / 帧率标准差） ---')
checks = []

# 0) A/B 可比性：两轮负载必须一致（否则温度/掉帧率的对比没有意义）
base_ok, base_desc = load_consistency(BASE)
therm_ok, therm_desc = load_consistency(THERM)
if BASE['layer'] is None or THERM['layer'] is None or BASE['spawn'] is None or THERM['spawn'] is None:
    print('  ⚠ 缺少 load_gpu_layers/spawn_count 列，跳过负载一致性校验（结论可信度下降）')
    checks.append(('两轮负载一致（缺列，未校验）', True))
else:
    same = (list(unique_vals(BASE['layer'])) == list(unique_vals(THERM['layer']))
            and list(unique_vals(BASE['spawn'])) == list(unique_vals(THERM['spawn'])))
    ok = base_ok and therm_ok and same
    checks.append(('两轮负载一致 (%s | %s)' % (base_desc, therm_desc), ok))
    print('  load  base: %s    therm: %s' % (base_desc, therm_desc))
    if not ok:
        print('  ⚠ 两轮负载不一致：温度/掉帧率的差值里有"负载不同"的成分，结论无效。'
              '请用同样的滑块重新跑 A/B。')

# 1) 平均温度下降（方案写的是"核心依据"，必须进判定）
#    判定用稳态窗口（最后 15 分钟）均值；同时打印"相对各自起点的升温幅度"作参考，
#    抵消两轮起始温度/室温不同带来的偏差。
b_steady, t_steady = steady(BT), steady(TT)
temp_drop = b_steady.mean() - t_steady.mean()
rise_b = float(b_steady.mean() - BT[:max(1, min(12, len(BT) // 4))].mean())
rise_t = float(t_steady.mean() - TT[:max(1, min(12, len(TT) // 4))].mean())
checks.append(('平均温度下降（稳态窗口 %.0f 分钟, Δ=%.2f℃）' % (steady_len(len(BT)) * ROW_SECONDS / 60.0, temp_drop),
               temp_drop > TEMP_DROP_MIN))
print('  temp  稳态 %.2f -> %.2f ℃ (Δ=%+.2f)   全段均值 %.2f -> %.2f'
      % (b_steady.mean(), t_steady.mean(), temp_drop, BT.mean(), TT.mean()))
print('  temp  [参考] 相对起点升温 %.2f -> %.2f ℃（抵消起始温度差）' % (rise_b, rise_t))
print('  temp  start %.1f / %.1f ℃（两轮起点相差 %.1f℃，越接近越可信）'
      % (BT[0], TT[0], abs(BT[0] - TT[0])))

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
    std_base = nmean(steady(BASE['fps_std']))
    std_therm = nmean(steady(THERM['fps_std']))
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
print('  说明：温度取最后 %.0f 分钟稳态窗口；两轮起点温差 >1℃ 时建议重跑。' % STEADY_MINUTES)
