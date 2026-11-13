#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""monitor_temp_ios.py —— monitor_temp_ios.bat / .ps1 的跨平台（macOS/Linux/Windows）版

为什么重写而不直接跑 .bat/.ps1：
  * .bat 是 Windows 批处理（Mac 没有 cmd）；
  * .ps1 里写死了 `idevicediagnostics.exe`、`tools\` 反斜杠路径、`python`/`py` 命令名，
    在 macOS 上都要改。
  * 读数逻辑本来就在 `ios_temp_reader.py`（pymobiledevice3），那一层是跨平台的，
    这里只是把它包成和 .bat 一样的命令行 + CSV 循环。

用法：
    python3 monitor_temp_ios.py                          # 每 5 秒采一次，写 temp_log_ios.csv
    python3 monitor_temp_ios.py -Interval 10 -Csv out.csv
    python3 monitor_temp_ios.py -Fresh                   # 清空重建 CSV（默认追加）
    python3 monitor_temp_ios.py -MaxSamples 120          # 采 120 条后退出
    python3 monitor_temp_ios.py -Diag                    # 只诊断，写 ios_diag.txt
    python3 monitor_temp_ios.py -SelfTest                # 不接设备，自测格式与解析
    python3 monitor_temp_ios.py -Mock                    # 不接设备，模拟温度跑流程

输出（与 Android 脚本、plot_temp.py、画对比图.py 完全一致）：
    Time,Temperature
    11:18:23,30.9

依赖：
    python3 -m pip install --only-binary :all: pymobiledevice3
    ios_temp_reader.py 与本脚本放同一目录
"""
import argparse
import asyncio
import importlib.util
import math
import os
import random
import subprocess
import sys
import time
from datetime import datetime

# Windows 控制台默认不是 UTF-8，中文会乱码；macOS/Linux 下这步是无害的
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:                  # noqa: BLE001  老版本 python 没有 reconfigure
        pass

DIR = os.path.dirname(os.path.abspath(__file__))
READER_PY = os.path.join(DIR, 'ios_temp_reader.py')


# ---------------------------------------------------------------- 读数层

def _load_reader():
    """把同目录的 ios_temp_reader.py 当模块加载（不触发它自己的 __main__）。"""
    if not os.path.isfile(READER_PY):
        return None
    spec = importlib.util.spec_from_file_location('ios_temp_reader', READER_PY)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:                      # noqa: BLE001  依赖缺失等
        return None
    return mod


_READER = _load_reader()


def read_temp(deep: bool = False):
    """返回摄氏度 float；读不到返回 None。"""
    if _READER is None:
        return None
    try:
        result = asyncio.run(_READER.read_temperature(deep=deep))
    except Exception:                      # noqa: BLE001
        return None
    if not isinstance(result, dict) or not result.get('ok'):
        return None
    try:
        return float(result['temp'])
    except (TypeError, ValueError, KeyError):
        return None


def mock_temp(elapsed: float) -> float:
    """模拟：25℃ 起步，10 分钟逼近 34℃，带小抖动。"""
    base = 25.0 + 9.0 * (1.0 - math.exp(-elapsed / 600.0))
    return round(base + random.uniform(-0.15, 0.15), 1)


# ---------------------------------------------------------------- 工具

def fmt(v) -> str:
    """统一成一位小数；非法/越界返回空串。"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ''
    if not (-30.0 < f < 120.0):
        return ''
    return f'{f:.1f}'


def now_hms() -> str:
    return datetime.now().strftime('%H:%M:%S')


def init_csv(path: str, fresh: bool) -> None:
    if fresh or not os.path.isfile(path):
        with open(path, 'w', encoding='ascii', newline='') as f:
            f.write('Time,Temperature\n')
        print(f'CSV: {path}（新建）')
    else:
        print(f'CSV: {path}（追加）')


def summary(temps, csv_path: str, started: float) -> None:
    print()
    print('=== 结束 ===')
    if temps:
        dur = int(time.time() - started)
        print(f'样本 {len(temps)} 个，时长 {dur} 秒')
        print(f'最低 {min(temps):.1f} C   最高 {max(temps):.1f} C   平均 {sum(temps) / len(temps):.1f} C')
    else:
        print('样本 0 个（没采到数据）')
    print(f'CSV: {csv_path}')
    print('画图: 把 plot_temp.py 里的 CSV_FILE 改成上面这个路径，再 python plot_temp.py')


# ---------------------------------------------------------------- 各模式

def run_selftest() -> int:
    print('=== 自测（不接设备）===')
    ok = True
    checks = [
        ('一位小数', fmt(30.94), '30.9'),
        ('非法输入被拒', fmt('abc'), ''),
        ('越界被拒', fmt(999), ''),
        ('None 被拒', fmt(None), ''),
    ]
    for name, got, want in checks:
        if got == want:
            print(f'  [PASS] {name}')
        else:
            print(f'  [FAIL] {name}: 期望 {want!r} 实际 {got!r}')
            ok = False
    if _READER is None:
        print('  [SKIP] 没有 ios_temp_reader.py 或依赖缺失，跳过解析自测')
    else:
        rc = subprocess.call([sys.executable, READER_PY, '--selftest'],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if rc == 0:
            print('  [PASS] ios_temp_reader.py --selftest')
        else:
            print('  [FAIL] ios_temp_reader.py --selftest')
            ok = False
    print()
    print('结果: 通过' if ok else '结果: 有失败')
    return 0 if ok else 1


def run_diag(deep: bool) -> int:
    out = os.path.join(os.getcwd(), 'ios_diag.txt')
    lines = [
        f'时间: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}',
        f'平台: {sys.platform}  python {sys.version.split()[0]}',
        f'reader: {READER_PY} {"(缺失)" if _READER is None else ""}',
        '',
    ]
    if _READER is None:
        lines.append('没有可用的 ios_temp_reader.py，无法诊断。')
    else:
        lines.append('=== reader 自测 ===')
        try:
            lines.append(subprocess.check_output(
                [sys.executable, READER_PY, '--selftest'], stderr=subprocess.STDOUT
            ).decode('utf-8', 'replace'))
        except subprocess.CalledProcessError as e:
            lines.append((e.output or b'').decode('utf-8', 'replace'))
        lines.append('=== 诊断 ===')
        cmd = [sys.executable, READER_PY, '--diag'] + (['--deep'] if deep else [])
        try:
            lines.append(subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode('utf-8', 'replace'))
        except subprocess.CalledProcessError as e:
            lines.append((e.output or b'').decode('utf-8', 'replace'))
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print(f'诊断已写入: {out}')
    print('\n'.join(lines[:20]))
    return 0


def run_loop(args) -> int:
    mock = bool(args.Mock)
    deep = bool(args.Deep)

    if not mock:
        if _READER is None:
            print('缺少依赖：需要 python3 + 同目录的 ios_temp_reader.py')
            print('  python3 -m pip install --only-binary :all: pymobiledevice3')
            return 1
        probe = fmt(read_temp(deep))
        if not probe:
            print('读不到温度。先用 -Diag 定位：')
            print('  python3 monitor_temp_ios.py -Diag')
            print('也确认：① 数据线连接；② iPhone 点了「信任此电脑」；③ 没锁屏')
            return 1
        print('读数: ios_temp_reader（pymobiledevice3）')
    else:
        print('读数: MOCK（模拟温度，不接设备）')

    init_csv(args.Csv, bool(args.Fresh))
    maxn = int(args.MaxSamples or 0)
    print(f'间隔: {args.Interval}s   MaxSamples: {"无限" if maxn == 0 else maxn}')
    print('开始采集（Ctrl+C 结束）…')

    started = time.time()
    temps = []
    fails = 0
    try:
        while True:
            elapsed = time.time() - started
            v = mock_temp(elapsed) if mock else read_temp(deep)
            t = fmt(v)
            if not t:
                fails += 1
                print(f'[{now_hms()}] 读取失败（连续 {fails} 次）')
                if fails >= 10:
                    print('连续失败 10 次，退出。请先用 -Diag 定位原因。')
                    break
            else:
                fails = 0
                ts = now_hms()
                with open(args.Csv, 'a', encoding='ascii', newline='') as f:
                    f.write(f'{ts},{t}\n')
                temps.append(float(t))
                print(f'{ts}  {t:>5} C')
            if maxn > 0 and len(temps) >= maxn:
                break
            if args.Interval > 0:
                time.sleep(args.Interval)
    except KeyboardInterrupt:
        pass
    finally:
        summary(temps, args.Csv, started)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        prog='monitor_temp_ios.py',
        description='iOS 电池温度采集（CSV 与 Android 脚本一致）',
        add_help=False,
    )
    ap.add_argument('-Interval', '--interval', dest='Interval', type=int, default=5, help='采样间隔秒，默认 5')
    ap.add_argument('-Csv', '--csv', dest='Csv', default='temp_log_ios.csv', help='CSV 路径')
    ap.add_argument('-MaxSamples', '--max-samples', dest='MaxSamples', type=int, default=0, help='采够多少条退出，0=无限')
    ap.add_argument('-Fresh', '--fresh', dest='Fresh', action='store_true', help='清空重建 CSV')
    ap.add_argument('-Diag', '--diag', dest='Diag', action='store_true', help='诊断模式')
    ap.add_argument('-Deep', '--deep', dest='Deep', action='store_true', help='诊断/读取时多试慢入口')
    ap.add_argument('-Mock', '--mock', dest='Mock', action='store_true', help='模拟温度，不接设备')
    ap.add_argument('-SelfTest', '--selftest', dest='SelfTest', action='store_true', help='自测，不接设备')
    ap.add_argument('-h', '--help', dest='Help', action='store_true', help='显示帮助')
    args = ap.parse_args()

    if args.Help:
        ap.print_help()
        return 0
    if args.Interval < 0:
        print('-Interval 不能为负')
        return 2
    if args.SelfTest:
        return run_selftest()
    if args.Diag:
        return run_diag(args.Deep)
    return run_loop(args)


if __name__ == '__main__':
    sys.exit(main())
