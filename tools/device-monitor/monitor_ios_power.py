#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""monitor_ios_power.py —— iOS 27+ 的温度/功耗采集（温度读不到时用功耗代替）

为什么需要它：
  iPhone 13 / iOS 27.0.1 的 `diagnostics.get_battery()` 里**已经没有实时温度**
  （iPhone 17 / iOS 26.5.2 上有 `Temperature`，单位 0.01℃）。
  实测把 diagnostics relay + IORegistry（AppleSmartBattery / IOPMPowerSource /
  AppleARMPMUCharger / AppleSMC）全试了一遍，都不返回温度，只剩：
    - DeadBatteryBootData.*.AverageBattSkinTemp = 24   ← 历史值，不是当前温度
    - IOReportLegend 里的通道名 BatteryMaxTemp/…       ← 只是"能报什么"的目录，读不到值

  但同一份数据里有**实时功率遥测**（单位 mW，已用 mA×mV 交叉验证）：
    SystemLoad        整机实际功耗（986 + 384 ≈ 1370 = 下面的 PowerIn）
    BatteryPower      电池充/放电功率
    SystemPowerIn     适配器输入功率
    InstantAmperage / Voltage   可用于独立校验

  对热研究来说，**功耗比温度更接近"原因"**：温度是被散热和平台策略加工过的结果，
  功耗才是我们真正在控制的量。所以 iOS 27 上建议直接把指标从 ℃ 换成 mW。

输出（前两列与旧温度日志兼容，新列追加在后面）：
    Time,Temperature,Power_mW,BatteryPower_mW,PowerIn_mW,Amperage_mA,Voltage_mV
    10:05:18,NA,986,384,1370,86,4467

依赖：pymobiledevice3

用法：
    python monitor_ios_power.py -Csv out.csv -Interval 5
    python monitor_ios_power.py -Csv out.csv -MaxSamples 3      # 抽 3 条验证
"""
import argparse
import asyncio
import csv
import os
import sys
import time

HEADER = ['Time', 'Temperature', 'Power_mW', 'BatteryPower_mW', 'PowerIn_mW', 'Amperage_mA', 'Voltage_mV']


def flat(obj, prefix=''):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = (prefix + '.' + str(k)) if prefix else str(k)
            if isinstance(v, dict):
                out.update(flat(v, p))
            elif isinstance(v, (int, float)):
                out[p] = v
    return out


def num(d, *keys):
    for k in keys:
        v = d.get(k)
        if isinstance(v, (int, float)):
            return v
    return None


async def sample(diag):
    """返回一行：温度（iOS27 上恒为 None）、功耗、电池功率、输入功率、电流、电压"""
    try:
        bat = await diag.get_battery()
    except Exception as e:                                   # noqa: BLE001
        return None, 'get_battery 失败: %s' % e
    if not bat:
        return None, 'get_battery 返回空'
    f = flat(bat)

    # 温度：老系统有 Temperature（0.01℃），新系统没有
    temp = num(f, 'Temperature', 'BatteryTemperature', 'TemperatureC')
    if temp is not None and temp > 1000:      # 0.01℃ 口径
        temp = temp / 100.0

    load = num(f, 'PowerTelemetryData.SystemLoad')
    batt_p = num(f, 'PowerTelemetryData.BatteryPower', 'BatteryData.BatteryPower')
    p_in = num(f, 'PowerTelemetryData.SystemPowerIn')
    amp = num(f, 'InstantAmperage', 'Amperage')
    volt = num(f, 'Voltage', 'AppleRawBatteryVoltage')

    return {
        'Temperature': ('%.1f' % temp) if temp is not None else 'NA',
        'Power_mW': load if load is not None else 'NA',
        'BatteryPower_mW': batt_p if batt_p is not None else 'NA',
        'PowerIn_mW': p_in if p_in is not None else 'NA',
        'Amperage_mA': amp if amp is not None else 'NA',
        'Voltage_mV': volt if volt is not None else 'NA',
    }, ''


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-Csv', default='temp_log_ios.csv')
    ap.add_argument('-Interval', type=float, default=5)
    ap.add_argument('-MaxSamples', type=int, default=0, help='0 = 一直采')
    ap.add_argument('-Fresh', action='store_true', help='截断重建（默认就重建，保留此参数兼容旧脚本习惯）')
    args = ap.parse_args()

    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.diagnostics import DiagnosticsService

    lockdown = await create_using_usbmux()
    prod = lockdown.all_values.get('ProductType', '?')
    ver = lockdown.all_values.get('ProductVersion', '?')
    print('设备   : %s / iOS %s' % (prod, ver))

    # 默认重建：与 monitor_temp_ios.bat 的"每轮先清空"行为保持一致
    with open(args.Csv, 'w', newline='', encoding='utf-8') as fp:
        csv.writer(fp).writerow(HEADER)
    print('输出   : %s' % os.path.abspath(args.Csv))
    print('间隔   : %ss   采满 %s 条后退出' % (args.Interval, args.MaxSamples or '∞'))
    print('')

    n = 0
    fails = 0
    rows = []
    async with DiagnosticsService(lockdown) as diag:
        while True:
            row, err = await sample(diag)
            ts = time.strftime('%H:%M:%S')
            if row is None:
                fails += 1
                print('[%s] 读取失败（连续 %d 次）%s' % (ts, fails, ('：' + err) if err else ''))
                if fails >= 10:
                    print('连续失败 10 次，退出。先跑 probe_ios_temp.py 诊断。')
                    break
            else:
                fails = 0
                line = [ts] + [row[k] for k in HEADER[1:]]
                with open(args.Csv, 'a', newline='', encoding='utf-8') as fp:
                    csv.writer(fp).writerow(line)
                rows.append(row)
                n += 1
                print('%s  %s℃  功耗 %s mW  （电池 %s / 输入 %s）'
                      % (ts, row['Temperature'], row['Power_mW'], row['BatteryPower_mW'], row['PowerIn_mW']))
            if args.MaxSamples and n >= args.MaxSamples:
                break
            await asyncio.sleep(args.Interval)

    print('')
    print('=== 结束 ===')
    if rows:
        def col(k):
            vals = [float(r[k]) for r in rows if r[k] != 'NA']
            return (min(vals), max(vals), sum(vals) / len(vals)) if vals else None
        stat = col('Power_mW')
        if stat:
            print('功耗：最低 %.0f / 最高 %.0f / 平均 %.0f mW（%d 条）' % (stat[0], stat[1], stat[2], len(rows)))
        else:
            print('功耗：没有可用读数')
        if rows[0]['Temperature'] != 'NA':
            tstat = col('Temperature')
            print('温度：最低 %.1f / 最高 %.1f / 平均 %.1f ℃' % tstat)
        else:
            print('温度：本机读不到（iOS 27 起已移除该字段），只能用功耗')
    else:
        print('没有采到数据')
    print('CSV:', os.path.abspath(args.Csv))
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
