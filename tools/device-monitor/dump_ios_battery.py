#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dump_ios_battery.py —— 把 iOS 电池/温度相关的原始数据全量打出来（诊断用）

背景：iPhone 13 / iOS 27.0.1 上 `diagnostics.get_battery()` 里**找不到任何 temperature 字段**，
而 iPhone 17 / iOS 26.5.2 上有 `Temperature`（单位 0.01℃）。
说明新版 iOS 可能改了字段名或换了服务，需要先看"到底返回了什么"。

用法：
    python dump_ios_battery.py            # 打 battery + GasGauge 的全部字段
    python dump_ios_battery.py --json out.json   # 同时存一份原始 JSON

依赖：pymobiledevice3
"""
import argparse
import asyncio
import json
import sys

MAX_LEN = 120


def trim(v):
    s = str(v)
    return s if len(s) <= MAX_LEN else s[:MAX_LEN] + '…'


def walk(obj, prefix=''):
    """把嵌套 dict 摊平成 (路径, 值)"""
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = (prefix + '.' + str(k)) if prefix else str(k)
            if isinstance(v, dict):
                out.extend(walk(v, p))
            elif isinstance(v, (list, tuple)):
                out.append((p, '[list len=%d] %s' % (len(v), trim(v[:3]))))
            else:
                out.append((p, trim(v)))
    return out


async def dump(deep=False):
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.diagnostics import DiagnosticsService

    lockdown = await create_using_usbmux()
    print('设备:', lockdown.short_info.get('DeviceName'),
          '/', lockdown.all_values.get('ProductType'),
          '/ iOS', lockdown.all_values.get('ProductVersion'))
    print('')

    result = {}
    async with DiagnosticsService(lockdown) as diag:
        # ① 电池
        for label, fn in (('diagnostics.battery', 'get_battery'),
                          ('diagnostics.GasGauge', 'get_gasguage'),
                          ('diagnostics.GasGauge2', 'get_gasguage')):
            if not hasattr(diag, fn):
                print('[跳过] DiagnosticsService 没有 %s' % fn)
                continue
            try:
                data = await getattr(diag, fn)()
            except Exception as e:                      # noqa: BLE001
                print('[%s] 调用失败: %s' % (label, e))
                continue
            rows = walk(data)
            print('==== %s：共 %d 个字段 ====' % (label, len(rows)))
            temp_like = [r for r in rows if 'temp' in r[0].lower()]
            print('  其中含 temp 的 %d 个：' % len(temp_like))
            for k, v in temp_like:
                print('    %-46s = %s' % (k, v))
            print('  全部字段：')
            for k, v in rows:
                print('    %-46s = %s' % (k, v))
            print('')
            result[label] = data

        # ② IORegistry（iOS 26 起据说被收紧，但换个系统也许可用）
        if hasattr(diag, 'ioregistry'):
            for name in ('AppleSmartBattery', 'IOPMPowerSource', 'AppleARMPMUCharger'):
                try:
                    data = await diag.ioregistry(name=name)
                except Exception as e:                  # noqa: BLE001
                    print('[ioregistry %s] 失败: %s' % (name, e))
                    continue
                if not data:
                    print('[ioregistry %s] 返回空' % name)
                    continue
                rows = walk(data)
                print('==== ioregistry %s：共 %d 个字段 ====' % (name, len(rows)))
                for k, v in rows:
                    if 'temp' in k.lower() or 'capacity' in k.lower():
                        print('    %-46s = %s' % (k, v))
                result['ioregistry.' + name] = data

    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', default='')
    ap.add_argument('--deep', action='store_true')
    args = ap.parse_args()
    try:
        data = asyncio.run(dump(args.deep))
    except Exception as e:                              # noqa: BLE001
        print('整体失败:', type(e).__name__, e, file=sys.stderr)
        return 1
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2, default=str)
        print('原始 JSON 已写入:', args.json)
    return 0


if __name__ == '__main__':
    sys.exit(main())
