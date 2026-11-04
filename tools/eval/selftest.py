"""_eval_thermal.py 的自测：用合成数据验证判定口径（不需要真机数据）。

跑法：
    python tools/eval/selftest.py

覆盖两件事：
  1) 新 15 列 CSV（含 drop_rate_cur）：判定应当用 drop_rate_cur，温度进判定，fps/p95 只做参考。
  2) 旧 14 列 CSV：不崩溃、提示缺列、回退到 drop_rate 并给出"可能误判"的告警。
"""
import csv
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL = os.path.join(HERE, '_eval_thermal.py')

COLS14 = ['elapsed_s', 'ts_ms', 'fps', 'ft_avg_ms', 'ft_p95_ms', 'ft_max_ms', 'jank_gt_2x',
          'battery_pct', 'load_gpu_layers', 'spawn_count', 'shading_scale', 'frame_rate',
          'fps_std', 'drop_rate']


def write_csv(path, rows, with_cur):
    cols = list(COLS14)
    if with_cur:
        cols.append('drop_rate_cur')
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)


def write_temp(path, temps):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['Time', 'Temperature'])
        for i, t in enumerate(temps):
            w.writerow(['00:%02d' % i, t])


def build_case(root, with_cur, base_drop, base_drop_cur, therm_drop, therm_drop_cur):
    """baseline = 稳定 60fps；thermal = 温控把目标降到 30fps、帧时间稳定 33.3ms。"""
    base = [[i * 5, 1000 + i * 5000, 60.0, 16.67, 16.67, 16.67, 0, 'NA', 3, 0,
             '1.00', 60, 0.50, base_drop, base_drop_cur] for i in range(40)]
    therm = [[i * 5, 1000 + i * 5000, 30.0, 33.30, 33.30, 33.30, 0, 'NA', 1, 0,
              '0.70', 30, 0.30, therm_drop, therm_drop_cur] for i in range(40)]
    if not with_cur:
        base = [r[:14] for r in base]
        therm = [r[:14] for r in therm]
    write_csv(os.path.join(root, 'base.csv'), base, with_cur)
    write_csv(os.path.join(root, 'therm.csv'), therm, with_cur)
    write_temp(os.path.join(root, 'basetemp.csv'), [42 + i * 0.1 for i in range(40)])
    write_temp(os.path.join(root, 'thermtemp.csv'), [40 + i * 0.05 for i in range(40)])


def run_eval(root):
    """把脚本里的 4 个路径常量替换成本次合成的数据，再作为子进程跑。"""
    src = open(EVAL, encoding='utf-8').read()
    pairs = [
        (r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_A\thermal_A.csv', os.path.join(root, 'base.csv')),
        (r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_B\thermal_B.csv', os.path.join(root, 'therm.csv')),
        (r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_A\temp_log.csv', os.path.join(root, 'basetemp.csv')),
        (r'C:\Users\Administrator\Desktop\温控测试数据\OPPO_Pad_Mini_B\temp_log.csv', os.path.join(root, 'thermtemp.csv')),
    ]
    for old, new in pairs:
        src = src.replace(old, new)
    script = os.path.join(root, 'eval_copy.py')
    open(script, 'w', encoding='utf-8').write(src)
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    return subprocess.run([sys.executable, script], capture_output=True, text=True,
                          encoding='utf-8', errors='replace', env=env)


def main():
    results = []

    def check(name, cond):
        results.append((name, bool(cond)))
        print(('PASS  ' if cond else 'FAIL  ') + name)

    # ---- 用例 1：新 15 列 CSV ----
    root = tempfile.mkdtemp(prefix='eval15_')
    try:
        build_case(root, True, base_drop=12.0, base_drop_cur=12.0, therm_drop=100.0, therm_drop_cur=2.0)
        out = run_eval(root)
        so = out.stdout
        check('15 列: 正常退出', out.returncode == 0)
        check('15 列: 判定口径用 drop_rate_cur', '[drop_rate_cur]' in so)
        check('15 列: 掉帧率判 PASS（12% -> 2%）', '[PASS] 掉帧率下降' in so)
        check('15 列: 温度进判定', '[PASS] 平均温度下降' in so)
        check('15 列: fps 只做参考', '[参考] fps' in so and '[PASS] 平均帧率' not in so)
        check('15 列: p95 只做参考', '[参考] p95' in so and 'p95 帧时间下降 >= 20%' not in so)
        check('15 列: 最终判定达标', '达标：是' in so)
        if out.returncode != 0:
            print(out.stderr[-800:])
    finally:
        shutil.rmtree(root, ignore_errors=True)

    # ---- 用例 2：旧 14 列 CSV ----
    root = tempfile.mkdtemp(prefix='eval14_')
    try:
        build_case(root, False, base_drop=12.0, base_drop_cur=0.0, therm_drop=100.0, therm_drop_cur=0.0)
        out = run_eval(root)
        so = out.stdout
        check('14 列: 正常退出', out.returncode == 0)
        check('14 列: 提示缺 drop_rate_cur', 'drop_rate_cur 缺失' in so)
        check('14 列: 回退口径提示', '只能用固定预算的 drop_rate' in so)
        check('14 列: 用 drop_rate 判且 FAIL', '[FAIL] 掉帧率下降 [drop_rate]' in so)
        if out.returncode != 0:
            print(out.stderr[-800:])
    finally:
        shutil.rmtree(root, ignore_errors=True)

    passed = sum(1 for _, ok in results if ok)
    print('\n==== 结果: %d/%d 通过 ====' % (passed, len(results)))
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
