# -*- coding: utf-8 -*-
"""
读取 temp_log.csv 并可视化温升曲线
支持 bat 和 PowerShell 脚本生成的格式: Time,Temperature
"""

import os
import sys
from datetime import datetime, timedelta

import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates


# ====== 配置区 ======
CSV_FILE = "temp_log.csv"          # CSV 文件路径
OUTPUT_IMG = "temp_curve.png"      # 输出图片路径
TITLE = "手机电池温度监控"           # 图表标题
SHOW_PLOT = True                   # 是否弹窗显示
# ===================


def load_data(csv_file):
    """读取 CSV，兼容多种编码和列名"""
    if not os.path.exists(csv_file):
        print(f"[错误] 找不到文件: {csv_file}")
        sys.exit(1)

    # 尝试多种编码，兼容 Windows 下 Out-File UTF8 带 BOM 的情况
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            df = pd.read_csv(csv_file, encoding=enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        print("[错误] 无法识别文件编码")
        sys.exit(1)

    # 统一列名
    df.columns = [c.strip() for c in df.columns]
    if "Time" not in df.columns or "Temperature" not in df.columns:
        print(f"[错误] 列名不符合预期: {list(df.columns)}")
        print("       期望列名: Time, Temperature")
        sys.exit(1)

    # 时间列可能是 "HH:mm:ss" 或完整时间戳，统一解析
    def parse_time(t):
        t = str(t).strip()
        try:
            return datetime.strptime(t, "%H:%M:%S")
        except ValueError:
            pass
        try:
            return pd.to_datetime(t)
        except Exception:
            return pd.NaT

    df["Time"] = df["Time"].apply(parse_time)
    df = df.dropna(subset=["Time", "Temperature"]).reset_index(drop=True)

    if df.empty:
        print("[错误] 数据为空")
        sys.exit(1)

    return df


def analyze(df):
    """输出关键统计信息"""
    temps = df["Temperature"]
    start_t = df["Time"].iloc[0]
    end_t = df["Time"].iloc[-1]

    # 处理跨零点的情况
    if end_t < start_t:
        end_t += timedelta(days=1)
        df["Time"] = df["Time"].apply(
            lambda x: x + timedelta(days=1) if x < start_t else x
        )

    duration = (end_t - start_t).total_seconds()
    temp_start = temps.iloc[0]
    temp_end = temps.iloc[-1]
    temp_max = temps.max()
    temp_min = temps.min()
    temp_delta = temp_end - temp_start
    rate = temp_delta / (duration / 60) if duration > 0 else 0

    print("=" * 40)
    print("  温度监控统计")
    print("=" * 40)
    print(f"  采样点数   : {len(df)}")
    print(f"  持续时间   : {duration / 60:.1f} 分钟")
    print(f"  起始温度   : {temp_start:.1f} °C")
    print(f"  结束温度   : {temp_end:.1f} °C")
    print(f"  最高温度   : {temp_max:.1f} °C")
    print(f"  最低温度   : {temp_min:.1f} °C")
    print(f"  温升幅度   : {temp_delta:+.1f} °C")
    print(f"  平均升温率 : {rate:+.2f} °C/分钟")
    print("=" * 40)

    return df, duration


def plot(df, duration):
    """绘制温升曲线"""
    # 中文字体（避免中文乱码，找不到则回退）
    for font in ("Microsoft YaHei", "SimHei", "Arial Unicode MS"):
        plt.rcParams["font.sans-serif"] = [font]
        break
    plt.rcParams["axes.unicode_minus"] = False

    fig, ax = plt.subplots(figsize=(10, 5))

    # 用采样序号作为 x 轴，避免跨零点时间显示问题
    x = range(len(df))
    y = df["Temperature"].values

    ax.plot(x, y, marker="o", markersize=3, linewidth=1.5,
            color="#e74c3c", label="电池温度")

    # 标注起始、最高、结束
    ax.axhline(y[0], color="gray", linestyle="--", linewidth=0.8, alpha=0.6)
    ax.annotate(f"起始 {y[0]:.1f}°C",
                xy=(0, y[0]), xytext=(5, 8),
                textcoords="offset points", fontsize=9, color="#555")

    max_idx = y.argmax()
    ax.annotate(f"最高 {y[max_idx]:.1f}°C",
                xy=(max_idx, y[max_idx]), xytext=(5, -15),
                textcoords="offset points", fontsize=9, color="#c0392b",
                arrowprops=dict(arrowstyle="->", color="#c0392b", lw=0.8))

    ax.annotate(f"结束 {y[-1]:.1f}°C",
                xy=(len(y) - 1, y[-1]), xytext=(-60, 10),
                textcoords="offset points", fontsize=9, color="#555")

    # 45℃ 警戒线
    if max(y) < 50:
        ax.axhline(45, color="orange", linestyle=":", linewidth=1, alpha=0.7)
        ax.text(len(df) * 0.01, 45.1, "45°C 警戒线",
                fontsize=8, color="orange")

    # 坐标轴
    ax.set_xlabel("采样点序号", fontsize=11)
    ax.set_ylabel("温度 (°C)", fontsize=11)
    ax.set_title(f"{TITLE}（时长 {duration / 60:.1f} 分钟）", fontsize=13)
    ax.grid(True, linestyle="--", alpha=0.4)
    ax.legend(loc="upper left", fontsize=9)

    # x 轴加时间刻度（取若干位置显示 HH:MM:SS）
    tick_count = min(8, len(df))
    step = max(1, len(df) // tick_count)
    ticks = list(range(0, len(df), step))
    labels = [df["Time"].iloc[i].strftime("%H:%M:%S") for i in ticks]
    ax.set_xticks(ticks)
    ax.set_xticklabels(labels, rotation=30, ha="right", fontsize=8)

    plt.tight_layout()
    plt.savefig(OUTPUT_IMG, dpi=150, bbox_inches="tight")
    print(f"[完成] 图片已保存: {os.path.abspath(OUTPUT_IMG)}")

    if SHOW_PLOT:
        plt.show()


def main():
    df = load_data(CSV_FILE)
    df, duration = analyze(df)
    plot(df, duration)


if __name__ == "__main__":
    main()