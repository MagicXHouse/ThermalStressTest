# -*- coding: utf-8 -*-
"""
iOS 温度读取桥接脚本（供 monitor_temp_ios.ps1 调用，也可单独使用）

背景：
    Android 有 adb shell dumpsys battery，直接就能读到 temperature；
    iOS 没有 adb，也没有公开 API 能读电池温度。
    免越狱环境下可行的办法是用 diagnostic relay（com.apple.mobile.diagnostics_relay）
    查询电池 / IORegistry 数据，里面带摄氏度字段。

    在 iPhone18,3 / iOS 26.5.2 上实测：
        diagnostics.get_battery() -> "Temperature": 3089   (单位 0.01 摄氏度 -> 30.89 C)
    ioreg 的 AppleARMPMUCharger / AppleSMC 在 iOS 26 上已经返回空。

用法:
    python ios_temp_reader.py             # 只输出温度数字，例如 30.9
    python ios_temp_reader.py --json      # 输出 JSON，便于脚本解析
    python ios_temp_reader.py --diag      # 诊断：列出所有候选字段和原始值
    python ios_temp_reader.py --deep      # 额外尝试更慢的入口
    python ios_temp_reader.py --selftest  # 不接设备，自测解析逻辑

退出码: 0 成功, 3 读不到（未连接 / 未解锁 / 未信任）
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any, Iterable

# 这些 key 是历史统计/上下限/关机记录，不是当前温度，必须排除
EXCLUDE_WORDS = (
    "lifetime",
    "maximum",
    "minimum",
    "shutdown",
    "algo",
    "samples",
    "threshold",
)

# key 名字 -> 置信度（越大越优先）
def key_score(key: str) -> int:
    k = key.lower()
    if k.endswith("lifetime") or any(w in k for w in EXCLUDE_WORDS):
        return -1
    last = k.split(".")[-1]
    if last == "batterytemperature":
        return 40
    if last == "temperature":
        return 30 if "." not in k else 20
    if "battery" in last and "temperature" in last:
        return 25
    if "temperature" in last:
        return 10
    return -1


def to_celsius(value: Any) -> float | None:
    """把原始数值换算成摄氏度。

    iOS 常见量纲：
        30.89        已经是摄氏度
        308.9        十分之一度
        3089         百分之一度（iOS 26 实测就是这个）
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    for divider in (1, 10, 100):
        t = v / divider
        if 5 <= t <= 120:
            return round(t, 1)
    return None


def walk(obj: Any, prefix: str = "") -> Iterable[tuple[str, Any]]:
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk(v, f"{prefix}.{k}" if prefix else str(k))
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            yield from walk(v, f"{prefix}[{i}]")
    else:
        yield prefix, obj


def pick_temperature(data: Any) -> tuple[float, str, Any] | None:
    """从一个数据源里挑出最可信的当前温度。"""
    best: tuple[int, float, str, Any] | None = None
    for key, value in walk(data):
        score = key_score(key)
        if score <= 0:
            continue
        c = to_celsius(value)
        if c is None:
            continue
        if best is None or score > best[0]:
            best = (score, c, key, value)
    if best is None:
        return None
    return best[1], best[2], best[3]


# ---------------- 设备侧读取 ----------------

async def _collect_with(ds, deep: bool = False) -> list[tuple[str, Any]]:
    results: list[tuple[str, Any]] = []

    # 1) 电池（iOS 26 上实测可用，Temperature 单位是 0.01 摄氏度）
    try:
        results.append(("diagnostics.battery", await asyncio.wait_for(ds.get_battery(), timeout=25)))
    except Exception as e:  # noqa: BLE001
        results.append((f"diagnostics.battery!{type(e).__name__}", None))

    # 2) 若干 IORegistry 入口（老版本 iOS 上常见）
    for name in ("AppleARMPMUCharger", "AppleSMC", "IOPMPowerSource"):
        try:
            r = await asyncio.wait_for(ds.ioregistry(name=name), timeout=20)
            results.append((f"ioregistry.{name}", r))
        except Exception as e:  # noqa: BLE001
            results.append((f"ioregistry.{name}!{type(e).__name__}", None))

    # 3) 诊断报告
    for diag_type in ("GasGauge",) + (("All",) if deep else ()):
        try:
            r = await asyncio.wait_for(ds.info(diag_type), timeout=60)
            results.append((f"diagnostics.{diag_type}", r))
        except Exception as e:  # noqa: BLE001
            results.append((f"diagnostics.{diag_type}!{type(e).__name__}", None))

    warm = [(n, d) for n, d in results if d]
    # 电池数据优先；其余入口只在前面的都没有命中时才值得尝试
    return warm if warm else results


async def read_temperature(deep: bool = False) -> dict[str, Any]:
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.diagnostics import DiagnosticsService

    info: dict[str, Any] = {"ok": False}
    try:
        lockdown = await asyncio.wait_for(create_using_usbmux(), timeout=40)
    except Exception as e:  # noqa: BLE001
        msg = str(e) or type(e).__name__
        info["error"] = (
            "无法连接设备："
            + msg
            + "（检查：数据线是否插好、手机是否解锁、是否点了“信任此电脑”）"
        )
        return info

    sources: list[tuple[str, Any]] = []
    async with lockdown:
        try:
            info["device"] = {
                "type": await lockdown.get_value(key="ProductType"),
                "version": await lockdown.get_value(key="ProductVersion"),
            }
        except Exception:  # noqa: BLE001
            pass

        async with DiagnosticsService(lockdown) as ds:
            sources = await _collect_with(ds, deep=deep)
    candidates: list[dict[str, Any]] = []
    for name, data in sources:
        if not data:
            continue
        hit = pick_temperature(data)
        if hit:
            temp, key, raw = hit
            candidates.append(
                {"source": name, "key": key, "temp": temp, "raw": raw, "score": key_score(key)}
            )

    if not candidates:
        info["error"] = "已连接，但没有找到可用的温度字段（可加 --diag 查看详细原因）"
        info["sources"] = [n for n, _ in sources]
        return info

    candidates.sort(key=lambda c: c["score"], reverse=True)
    best = candidates[0]
    info.update({"ok": True, "temp": best["temp"], "source": best["source"], "key": best["key"], "raw": best["raw"]})
    if len(candidates) > 1:
        info["alternatives"] = candidates[1:5]
    return info


# ---------------- 自测 ----------------

def selftest() -> int:
    passed = failed = 0

    def check(name, got, expect):
        nonlocal passed, failed
        if expect is None or got is None or isinstance(expect, str) or isinstance(got, str):
            ok = got == expect
        else:
            ok = abs(got - expect) < 0.05
        if ok:
            passed += 1
            print(f"  [PASS] {name} -> {got}")
        else:
            failed += 1
            print(f"  [FAIL] {name} 期望 {expect} 实际 {got}")

    print("量纲换算")
    check("百分之一度 3089", to_celsius(3089), 30.9)
    check("十分之一度 312", to_celsius(312), 31.2)
    check("已是摄氏度 31.2", to_celsius(31.2), 31.2)
    check("越界 99999", to_celsius(99999), None)
    check("非数字", to_celsius("abc"), None)

    print("字段挑选")
    sample = {
        "Temperature": 3089,
        "BatteryData": {
            "LifetimeData": {"MaximumTemperature": 510, "MinimumTemperature": 80},
            "AlgoTemperature": 1952972,
        },
        "BatteryShutdownReason": {"ShutDownTemperature": 0},
    }
    hit = pick_temperature(sample)
    check("忽略统计值，取 Temperature", hit[0] if hit else None, 30.9)
    check("命中的 key", hit[1] if hit else None, "Temperature")

    hit2 = pick_temperature({"BatteryData": {"BatteryTemperature": 331}})
    check("嵌套 BatteryTemperature", hit2[0] if hit2 else None, 33.1)

    print("JSON 序列化")
    try:
        json.dumps({"ok": True, "temp": 30.9})
        passed += 1
        print("  [PASS]")
    except Exception:  # noqa: BLE001
        failed += 1
        print("  [FAIL]")

    print(f"\n结果: 通过 {passed} 项，失败 {failed} 项")
    return 0 if failed == 0 else 1


# ---------------- 入口 ----------------

async def diag(deep: bool) -> int:
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.diagnostics import DiagnosticsService

    async with await create_using_usbmux() as lockdown:
        async with DiagnosticsService(lockdown) as ds:
            sources = await _collect_with(ds, deep=deep)
    print("==== iOS 温度诊断 ====")
    for name, data in sources:
        if data is None:
            print(f"\n[{name}] 无数据")
            continue
        rows = [(k, v, to_celsius(v)) for k, v in walk(data) if "temperature" in k.lower()]
        print(f"\n[{name}] 含 temperature 的字段 {len(rows)} 个")
        for k, v, c in rows:
            flag = "" if key_score(k) > 0 else "  (忽略: 统计/上下限)"
            print(f"    {k} = {v!r}  -> {c}{flag}")
        hit = pick_temperature(data)
        print(f"    => 选用: {hit}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="读取 iOS 电池温度")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--diag", action="store_true", help="诊断模式")
    ap.add_argument("--deep", action="store_true", help="额外尝试慢入口")
    ap.add_argument("--selftest", action="store_true", help="不接设备自测")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if args.diag:
        return asyncio.run(diag(args.deep))

    try:
        result = asyncio.run(read_temperature(deep=args.deep))
    except Exception as e:  # noqa: BLE001
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    elif result.get("ok"):
        print(result["temp"])
    else:
        print("ERROR: " + str(result.get("error")), file=sys.stderr)
        return 3

    return 0 if result.get("ok") else 3


if __name__ == "__main__":
    sys.exit(main())
