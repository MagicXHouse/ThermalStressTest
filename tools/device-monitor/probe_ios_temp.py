#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_ios_temp.py —— 在 iOS 27 上找一个能读到"温度"或"功耗"的入口

背景：iPhone 13 / iOS 27.0.1 上 `diagnostics.get_battery()` 已经**没有**实时温度字段
（iPhone 17 / iOS 26.5.2 上有 `Temperature`，单位 0.01℃）。
但同一份数据里仍有 `PowerTelemetryData`（mW 级功耗），IOReportLegend 里也列出了
`BatteryMaxTemp / BatteryAvgTemp / BatteryMinTemp` 这些**通道名**（能不能读是另一回事）。

本脚本做三件事：
  1. 试各种 ioregistry 名字，看哪个能返回带 temp 的实时值；
  2. 列出 `get_battery()` 里所有"数值型"的可疑功耗/温度字段（附单位推断）；
  3. 若拿到功耗字段，打印由 current/voltage 反算的瞬时功率，便于校验一致性。

用法：
    python probe_ios_temp.py
    python probe_ios_temp.py --seconds 5     # 每 5 秒采一次，连采 3 次看数值是否变化
"""
import argparse
import asyncio
import sys

IOREG_NAMES = [
    'AppleSmartBattery',
    'IOPMPowerSource',
    'AppleARMPMUCharger',
    'AppleSMC',
    'IOSurface',
    'AppleDisplay',
]

# 关注的关键字段（电池 / 功耗 / 温度）
INTEREST = ('temp', 'thermal', 'power', 'watt', 'current', 'voltage', 'amperage', 'load', 'energy')


def flat(obj, prefix=''):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = (prefix + '.' + str(k)) if prefix else str(k)
            if isinstance(v, dict):
                out.update(flat(v, p))
            elif isinstance(v, (int, float, bool, str)) and not isinstance(v, bool):
                out[p] = v
            elif isinstance(v, str):
                out[p] = v
    return out


async def once(diag, tag=''):
    print('===== %s =====' % (tag or 'sample'))
    try:
        bat = await diag.get_battery()
    except Exception as e:                                  # noqa: BLE001
        print('  get_battery 失败:', e)
        bat = None
    if bat:
        f = flat(bat)
        hot = {k: v for k, v in f.items() if any(w in k.lower() for w in INTEREST)}
        ifhot = {k: v for k, v in hot.items() if 'temp' in k.lower() or 'thermal' in k.lower()}
        print('  get_battery：%d 个数值字段，其中 temp/thermal %d 个' % (len(f), len(ifhot)))
        for k in sorted(ifhot):
            print('    %-50s = %s' % (k, hot[k]))
        # 功耗换算
        cur = f.get('InstantAmperage', f.get('Amperage'))
        vol = f.get('Voltage', f.get('AppleRawBatteryVoltage'))
        if isinstance(cur, (int, float)) and isinstance(vol, (int, float)):
            print('    换算：%s mA × %s mV = %.0f mW' % (cur, vol, cur * vol / 1000.0))
        for k in ('PowerTelemetryData.BatteryPower', 'PowerTelemetryData.SystemLoad',
                  'PowerTelemetryData.SystemPowerIn', 'PowerTelemetryData.SystemEffectiveTotalLoad',
                  'BatteryData.BatteryPower'):
            if k in f:
                print('    %-50s = %s' % (k, f[k]))

    # ioregistry 逐个试
    for name in IOREG_NAMES:
        try:
            data = await diag.ioregistry(name=name)
        except Exception as e:                              # noqa: BLE001
            msg = str(e).split('\n')[0][:70]
            print('  ioregistry %-22s 失败: %s' % (name, msg))
            continue
        if not data:
            print('  ioregistry %-22s 返回空' % name)
            continue
        f = flat(data)
        t = {k: v for k, v in f.items() if 'temp' in k.lower()}
        live = {k: v for k, v in t.items() if 'DeadBatteryBootData' not in k}
        print('  ioregistry %-22s 有值 %d 个，实时温度候选 %d 个' % (name, len(f), len(live)))
        for k in sorted(live)[:8]:
            print('      %-46s = %s' % (k, live[k]))
    print('')


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=float, default=0)
    ap.add_argument('--times', type=int, default=3)
    args = ap.parse_args()

    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.diagnostics import DiagnosticsService

    lockdown = await create_using_usbmux()
    print('设备: %s / %s / iOS %s' % (
        lockdown.short_info.get('DeviceName'),
        lockdown.all_values.get('ProductType'),
        lockdown.all_values.get('ProductVersion')))
    print('')

    async with DiagnosticsService(lockdown) as diag:
        if args.seconds <= 0:
            await once(diag)
        else:
            for i in range(args.times):
                await once(diag, 'sample %d/%d' % (i + 1, args.times))
                if i + 1 < args.times:
                    await asyncio.sleep(args.seconds)
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
