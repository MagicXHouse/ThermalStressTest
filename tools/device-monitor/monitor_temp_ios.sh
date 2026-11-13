#!/usr/bin/env bash
# monitor_temp_ios.sh —— monitor_temp_ios.bat 的 macOS / Linux 版入口
#
# .bat 是 Windows 批处理，Mac 上没有 cmd 跑不了；
# 真正的实现在同目录的 monitor_temp_ios.py（跨平台，读数复用 ios_temp_reader.py）。
# 这个脚本只是把参数原样转过去，保持和 .bat 一样的调用习惯。
#
# 用法（参数与 .bat 完全一致，区分大小写也行）：
#   ./monitor_temp_ios.sh                        # 每 5 秒采一次，写 temp_log_ios.csv
#   ./monitor_temp_ios.sh -Interval 10 -Csv out.csv
#   ./monitor_temp_ios.sh -Fresh                 # 清空重建 CSV
#   ./monitor_temp_ios.sh -MaxSamples 120
#   ./monitor_temp_ios.sh -Diag                  # 诊断，写 ios_diag.txt
#   ./monitor_temp_ios.sh -SelfTest              # 不接设备自测
#   ./monitor_temp_ios.sh -Mock                  # 模拟温度跑流程
#
# 依赖：
#   python3 -m pip install --only-binary :all: pymobiledevice3
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
PY=""
for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
    echo "找不到 python3。装一下："
    echo "  brew install python3        # macOS"
    echo "  sudo apt install python3    # Debian/Ubuntu"
    exit 1
fi

exec "$PY" "$DIR/monitor_temp_ios.py" "$@"
