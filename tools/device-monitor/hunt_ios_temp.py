#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""hunt_ios_temp.py —— 在 iOS 27 上把所有"可能带温度"的 diagnostics 请求都试一遍

`get_battery()` 只是 `IORegistry + EntryClass=IOPMPowerSource` 的便捷封装。
换成别的请求类型 / 平面 / 类名，也许能拿到温度：
  - Request: Battery / GasGauge / All / IORegistry(IODeviceTree) ...
  - EntryClass: IOPMPowerSource / AppleSmartBattery / AppleARMPMUCharger / AppleSMC ...

诊断 relay 的响应里只要出现 temp 相关的**数值**就会被打印出来。

用法：
    python hunt_ios_temp.py
    python hunt_ios_temp.py --json out.json
"""
import argparse
import asyncio
import json
import sys

# 直接作为 Request 发的动作名（relay 支持哪些由固件决定，试了才知道）
REQUESTS = ['Battery', 'GasGauge', 'All', 'NAND', 'WiFi', 'IOReport']

# IORegistry 平面 + 条目/类名组合
IOREG_QUERIES = [
    dict(ioclass='IOPMPowerSource'),
    dict(ioclass='AppleSmartBattery'),
    dict(name='AppleSmartBattery'),
    dict(name='IOPMPowerSource'),
    dict(name='AppleARMPMUCharger'),
    dict(name='AppleSMC'),
    dict(name='ApplePMU'),
    dict(plane='IODeviceTree'),
    dict(plane='IOService', name='AppleSmartBattery'),
    dict(plane='IODeviceTree', name='pmu'),
    dict(plane='IODeviceTree', name='backlight'),
]


def flat(obj, prefix=''):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = (prefix + '.' + str(k)) if prefix else str(k)
            if isinstance(v, dict):
                out.update(flat(v, p))
            elif isinstance(v, list):
                for i, it in enumerate(v[:3]):
                    if isinstance(it, dict):
                        out.update(flat(it, '%s[%d]' % (p, i)))
            elif isinstance(v, (int, float)):
                out[p] = v
    return out


def report(label, data, temperature_bag):
    if not data:
        print('  %-46s → 空' % label)
        return
    f = flat(data)
    hits = {k: v for k, v in f.items() if 'temp' in k.lower()}
    # 排除历史残留（DeadBatteryBootData）
    live = {k: v for k, v in hits.items() if 'DeadBatteryBootData' not in k}
    print('  %-46s → %d 字段，temp 命中 %d（其中疑似实时 %d）'
          % (label, len(f), len(hits), len(live)))
    for k, v in sorted(live.items())[:10]:
        print('      ★ %-44s = %s' % (k, v))
        temperature_bag.append((label, k, v))


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', default='')
    args = ap.parse_args()

    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.diagnostics import DiagnosticsService

    lockdown = await create_using_usbmux()
    print('设备: %s / %s / iOS %s\n' % (
        lockdown.short_info.get('DeviceName'),
        lockdown.all_values.get('ProductType'),
        lockdown.all_values.get('ProductVersion')))

    bag = []
    raw = {}

    async with DiagnosticsService(lockdown) as diag:
        print('==== ① 直接当 Request 发 ====')
        for req in REQUESTS:
            try:
                data = await diag.action(req)
            except Exception as e:                     # noqa: BLE001
                print('  %-46s → 失败: %s' % ('Request=' + req, str(e).split(chr(10))[0][:60]))
                continue
            raw['req.' + req] = data
            report('Request=' + req, data, bag)

        print('\n==== ② IORegistry 各种组合 ====')
        for q in IOREG_QUERIES:
            label = 'IORegistry ' + json.dumps(q, ensure_ascii=False)
            try:
                data = await diag.ioregistry(**q)
            except Exception as e:                     # noqa: BLE001
                print('  %-46s → 失败: %s' % (label, str(e).split(chr(10))[0][:60]))
                continue
            raw['io.' + json.dumps(q)] = data
            report(label, data, bag)

    print('\n==== 汇总：所有疑似"实时温度"字段 ====')
    if not bag:
        print('  一个都没有 —— 这条路（diagnostics relay）在 iOS 27 上确实拿不到温度。')
    else:
        seen = set()
        for label, k, v in bag:
            key = (k, str(v))
            if key in seen:
                continue
            seen.add(key)
            print('  %-40s %-38s = %s' % (label[:40], k, v))

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as fp:
            json.dump(raw, fp, ensure_ascii=False, indent=1, default=str)
        print('\n原始响应已写入:', args.json)
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
