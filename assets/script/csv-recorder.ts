import { game, director } from 'cc';

/**
 * 帧时间自采 + CSV 记录。从 StressTestController 里拆出来的，行为与拆分前逐字一致。
 *
 * 控制器持有它：this.csv.start() / stop() / tick() / printCsv(n) / exportCsv() / cleanOld() / autoExport()。
 * 它只读控制器的少量状态（平面层数、立方体数、writeCsv、_log），写回只有 lastFps。
 */

/** CSV 表头：列名与顺序保持历史兼容，不要改（已有分析脚本依赖它） */
// elapsed_s     从 startLogging 起算的秒数（每行覆盖 5 秒窗口）
// ts_ms         performance.now() 绝对时间戳，跟 adb 温度采样对齐用
// fps           窗口平均帧率 = 1000 / ft_avg_ms
// ft_avg_ms     窗口平均帧时间（核心指标）
// ft_p95_ms     95 分位帧时间
// ft_max_ms     窗口内最慢一帧
// jank_gt_2x    超过 2 倍预算（>33.3ms）的帧数，判"真卡顿"用这列
// battery_pct   电量百分比（wx.getBatteryInfoSync，非微信环境为 NA）
// load_gpu_layers 实际参与压测的平面层数（历史列名，场景 A 专用）
// spawn_count   立方体数量（场景 B 用）
// shading_scale 当前 DRS 缩放档（温控降过档会变 0.85/0.7/0.3）
// frame_rate    game.frameRate 帧率档位（不是实测 fps）
// fps_std       窗口内逐帧 FPS 的标准差 = 抖动
// drop_rate     超过"采样起点预算"的帧占比 %，跨温控阶段可比；判定含 5% 容差（见 _flushRow 的 DROP_TOLERANCE）
//               —— 不加容差时，VSYNC 抖动 + performance.now() 的浮点误差会让"满帧 60fps"也报 ~59% 掉帧
// drop_rate_cur 超过"当前目标帧率（1000/game.frameRate）"的帧占比 %。温控降帧后它应当下降，
//               这是场景 B「温控后掉帧率下降」这条门槛的判据
export const CSV_HEADER = 'elapsed_s,ts_ms,fps,ft_avg_ms,ft_p95_ms,ft_max_ms,jank_gt_2x,battery_pct,load_gpu_layers,spawn_count,shading_scale,frame_rate,fps_std,drop_rate,drop_rate_cur';

export class CsvRecorder {
    /** 定时快照的固定文件名（覆盖写）：崩溃最多丢一个 60s 周期 */
    private static readonly LATEST_FILE = 'thermal_latest.csv';

    /**
     * 掉帧判据的容差系数（1.05 = 允许超出预算 5%）。
     *
     * 为什么必须有：判据原来是 `frames[i] > budget`，而 budget = 1000 / game.frameRate，
     * 帧间隔来自 performance.now() 差值累加，天然带 1e-13 量级浮点误差
     * （实测 16.66666666666697 > 16.666666666666668）→ 连"满帧 60fps 且零抖动"都会被算成 59% 掉帧；
     * 再加上 VSYNC/限帧抖动，任何稳定档位的掉帧率都会在 50%~100% 乱跳，
     * 而"掉帧率下降"是合入门槛之一，噪声会把结论带偏。
     * 5% 容差（60fps 下 16.667 → 17.5ms）只吃掉测量噪声，不会漏掉真正的掉帧。
     */
    private static readonly DROP_TOLERANCE = 1.05;

    /**
     * 超过这个间隔的"帧"不是帧（切后台、断点、GC 长停顿），直接丢弃。
     * 与引擎侧 `FrameTimeSampler.MAX_FRAME_DELTA_MS` 保持同一个值：
     * 温控内部丢弃了它，但 CSV 若照收，会把这个 30 秒的间隔写进
     * ft_avg/ft_max/jank/drop_rate，一行数据全废（S-04 就是查这个）。
     */
    private static readonly MAX_FRAME_DELTA_MS = 1000;

    /** 累计丢弃的长间隔个数（切后台次数），getStatus().csvGaps 可查 */
    private _gapCount = 0;

    /** 采样开始后丢弃过几次"长间隔" */
    public get gaps (): number { return this._gapCount; }

    /** 宿主控制器（用 any：拆模块时不引入类型环，且要读私有字段） */
    private _ctrl: any;

    /** 是否正在采集 */
    private _sampling = false;
    /** 上一帧的 performance.now()，用来算帧间隔 */
    private _lastFrameNow = 0;
    /** 当前 5 秒窗口的起点 */
    private _windowStart = 0;
    /** 当前窗口内的逐帧耗时（ms） */
    private _windowFrames: number[] = [];
    /** 已采集的行（第 0 行是表头） */
    private _rows: string[] = [];
    /** 开始采集的时间戳 */
    private _startTimestamp = 0;
    /** 采样开始时刻的帧时间预算（ms），固定不随温控降帧漂移，用于 drop_rate/jank 判定 */
    private _baseBudgetMs = 1000 / 60;
    /** 最近一个完整窗口的平均 fps，给 getStatus / DRS 日志用 */
    private _lastFps = 0;

    /** 每出一行后的回调（控制器用它刷新屏幕档位标签） */
    public onRow: (() => void) | null = null;

    constructor (ctrl: any) {
        this._ctrl = ctrl;
    }

    public get sampling (): boolean { return this._sampling; }
    public get lastFps (): number { return this._lastFps; }
    public get rowCount (): number { return this._rows.length; }

    /** 开始采集：每 5 秒统计一行。会清空之前的所有行（含表头重建） */
    public start (): void {
        this._sampling = true;
        this._startTimestamp = performance.now();
        this._windowStart = this._startTimestamp;
        this._lastFrameNow = 0;
        this._windowFrames.length = 0;
        this._rows.length = 0;
        this._rows.push(CSV_HEADER);
        // 固定基准预算：drop_rate / jank 判定用采样开始时的目标帧率，不跟随温控降帧后实时 game.frameRate 漂移，
        // 否则"温控前后"两段数据的掉帧率/卡顿次数不可比（阈值会从 16.667ms 漂到 33.33ms）。
        this._baseBudgetMs = 1000 / (Number(game.frameRate) || 60);
        console.log('[StressTest] frame-time sampling started (1 row / 5s, baseBudget='
            + this._baseBudgetMs.toFixed(2) + 'ms, writeCsv=' + this._ctrl.writeCsv + ')');
    }

    /** 停止采集（已采集的行保留，仍可 exportCsv） */
    public stop (): void {
        this._sampling = false;
        console.log('[StressTest] sampling stopped; rows=' + (this._rows.length - 1));
    }

    /** 每帧调一次：没在采样时只做一次布尔判断，开销可忽略（红线 2） */
    public tick (): void {
        if (!this._sampling) return;
        const now = performance.now();
        if (this._lastFrameNow > 0) {
            const delta = now - this._lastFrameNow;
            if (delta > CsvRecorder.MAX_FRAME_DELTA_MS) {
                // 切后台/断点回来的第一个间隔是"几十秒"，它会把 ft_avg/ft_max/drop_rate 全部污染。
                // 丢弃它（不 push），只记一次日志和计数；下一帧的间隔仍然正确。
                this._gapCount++;
                if (this._gapCount <= 3) {
                    console.log('[StressTest] 忽略 ' + Math.round(delta)
                        + 'ms 的长间隔（切后台/断点），不计入统计；累计 ' + this._gapCount + ' 次');
                }
            } else {
                this._windowFrames.push(delta);
            }
        }
        this._lastFrameNow = now;
        if (now - this._windowStart >= 5000) {   // 每 5 秒一行，跟 adb 温度采样对齐
            this._flushRow(now);
            this._windowStart = now;
            this._windowFrames.length = 0;
        }
    }

    /**
     * 把已采集的 CSV 打到控制台（真机排查用）。
     * 微信真机调试窗口里执行 `stressTest.printCsv(12)` 就能看最近 12 行，直接复制走。
     * @param lastN 只要最近 N 行；0 = 全部
     */
    public printCsv (lastN: number = 0): void {
        const total = this._rows.length;
        if (total <= 1) {
            console.warn('[StressTest] 还没有 CSV 数据');
            return;
        }
        let out: string[];
        if (lastN > 0 && lastN < total - 1) {
            out = [this._rows[0]].concat(this._rows.slice(total - lastN));
        } else {
            out = this._rows;
        }
        console.log('[StressTest][csv] rows=' + (total - 1) + '\n' + out.join('\n'));
    }

    /**
     * 把已采集的 CSV 复制到系统剪贴板（真机/测试同事最省事的取数方式）。
     *
     * 为什么返回摘要而不是文本本身：命令通道会把返回值 `JSON.stringify` 回显，
     * 若返回整个 CSV（几十 KB）会在控制台刷两遍。文本已经写进剪贴板了。
     *
     * @param lastN 只要最近 N 行；0 = 全部。数据量建议：≤200 行走剪贴板，
     *              更长用 {@link exportCsv}（文件更适合 30 分钟长测）。
     */
    public copyCsv (lastN: number = 0): any {
        const total = this._rows.length;
        if (total <= 1) {
            console.warn('[StressTest] 还没有 CSV 数据');
            return { copied: false, reason: 'no-data' };
        }
        let out: string[];
        if (lastN > 0 && lastN < total - 1) {
            out = [this._rows[0]].concat(this._rows.slice(total - lastN));
        } else {
            out = this._rows;
        }
        const text = out.join('\n');
        const rows = out.length - 1;
        // 跨度：用于现场核对"复制的数据覆盖了多久"，不必再去翻行
        const firstElapsed = Number(out.length > 1 ? String(out[1]).split(',')[0] : 0) || 0;
        const lastElapsed = Number(out.length > 1 ? String(out[out.length - 1]).split(',')[0] : 0) || 0;
        const span = Number((lastElapsed - firstElapsed).toFixed(1));
        // 注意：这是 UTF-8 下的字符数近似（本 CSV 全 ASCII，字符数 = 字节数）
        const bytes = text.length;
        // 体积经验值：约 78 字节/行 → 30 分钟 ≈ 27KB、1 小时 ≈ 55KB。
        // 没有官方文档给出 wx.setClipboardData 的硬上限，这里按"明显过大就别指望剪贴板"给个软阈值：
        // 超过就仍然复制（不改用户意图），但回一句 warn 引导改用 export / copy:N。
        const LARGE_BYTES = 256 * 1024;
        const warn = bytes > LARGE_BYTES ? 'large' : undefined;
        if (warn) {
            console.warn('[StressTest] CSV 体积偏大（' + Math.round(bytes / 1024) + 'KB），剪贴板可能失败；'
                + '建议改用 s(\'export\') 导出文件，或 s(\'copy:200\') 只复制最近 200 行');
        }
        const wx = this._getWx();

        if (wx && typeof wx.setClipboardData === 'function') {
            wx.setClipboardData({
                data: text,
                success: () => console.log('[StressTest] CSV 已复制到剪贴板：' + rows + ' 行 / ' + bytes + ' 字节'),
                fail: (e: any) => console.warn('[StressTest] 复制到剪贴板失败: ' + (e && e.errMsg)),
            });
            return { copied: true, rows, bytes, span, warn };
        }

        // 非微信（编辑器预览 / 单测）：退回打印，浏览器里可以手动复制
        console.log('[StressTest][csv] ' + text);
        return { copied: false, reason: 'no-wx-clipboard', rows, bytes, span, warn };
    }

    /**
     * 自检：把当前 CSV 的完整性指标算出来（H-01 / H-04 用）。
     *
     * 检查项：
     * - 行数与跨时长（判"有没有丢行"）
     * - `elapsed_s` 的步长分布（正常恒为 5；出现 10 说明中间丢了一行）
     * - `ts_ms` 是否单调递增（回退/重复说明时钟或写入有问题）
     * - 出现过的 (load_gpu_layers, spawn_count) 组合及各自行数（判"一轮里负载有没有变"，H-04）
     * - 出现过的 shading_scale / frame_rate（判"是不是混了多个档位"）
     */
    public inspect (): any {
        const rows = this._rows;
        const n = rows.length - 1;
        if (n <= 0) {
            return { rows: 0, note: '还没有数据行' };
        }
        const stepHist = new Map<number, number>();
        const loads = new Map<string, number>();
        const scales = new Map<number, number>();
        const rates = new Map<number, number>();
        let prevElapsed = NaN;
        let prevTs = NaN;
        let stepMin = Infinity;
        let stepMax = -Infinity;
        let tsBackwards = 0;
        let tsDuplicates = 0;
        let firstElapsed = NaN;
        let lastElapsed = NaN;
        let firstBattery = NaN;
        let lastBattery = NaN;

        for (let i = 1; i < rows.length; i++) {
            const c = rows[i].split(',');
            const elapsed = Number(c[0]);
            const ts = Number(c[1]);
            if (i === 1) { firstElapsed = elapsed; firstBattery = Number(c[7]); }
            lastElapsed = elapsed;
            lastBattery = Number(c[7]);

            if (Number.isFinite(prevElapsed)) {
                const step = Number((elapsed - prevElapsed).toFixed(3));
                stepHist.set(step, (stepHist.get(step) || 0) + 1);
                if (step < stepMin) stepMin = step;
                if (step > stepMax) stepMax = step;
            }
            if (Number.isFinite(prevTs)) {
                if (ts < prevTs) tsBackwards++;
                else if (ts === prevTs) tsDuplicates++;
            }
            const loadKey = c[8] + ':' + c[9];
            loads.set(loadKey, (loads.get(loadKey) || 0) + 1);
            const s = Number(c[10]);
            scales.set(s, (scales.get(s) || 0) + 1);
            const f = Number(c[11]);
            rates.set(f, (rates.get(f) || 0) + 1);

            prevElapsed = elapsed;
            prevTs = ts;
        }

        return {
            rows: n,
            spanSeconds: Number((lastElapsed - firstElapsed).toFixed(1)),
            stepMin,
            stepMax,
            stepHistogram: Array.from(stepHist.entries()).map(([k, v]) => k + 's×' + v),
            tsBackwards,
            tsDuplicates,
            battery: firstBattery + '→' + lastBattery,
            loads: Array.from(loads.entries()).map(([k, v]) => k + '×' + v),
            scales: Array.from(scales.entries()).map(([k, v]) => k + '×' + v),
            rates: Array.from(rates.entries()).map(([k, v]) => k + '×' + v),
        };
    }

    /**
     * 手动/归档导出：写入 `thermal_<A|B>_<时间戳>.csv`。
     * A/B 取自 enableThermalControl（温控关 = baseline A，温控开 = B），避免两轮数据混在同一堆
     * thermal_*.csv 里只能靠内容猜。
     */
    public exportCsv (): string | null {
        if (!this._ctrl.writeCsv) {
            console.warn('[StressTest] writeCsv is off; skip file export');
            return null;
        }
        if (this._rows.length <= 1) {
            console.warn('[StressTest] no CSV data');
            return null;
        }
        const wx = this._getWx();
        if (!wx || !wx.getFileSystemManager) {
            console.log('[StressTest] CSV sampling (non-WeChat): ' + (this._rows.length - 1) + ' rows');
            return null;
        }
        // A/B 标记取自面板 enableThermalControl；但如果运行时实际状态与面板不一致（典型场景：
        // baseline 包里手动 s('on') 开了温控），再补一个 X 后缀（AX / BX），避免把"实际被温控
        // 干预过的数据"误标成 baseline。混一起会让 A/B 对比作废。
        const panel = !!this._ctrl.enableThermalControl;
        const active = !!(this._ctrl.isThermalActive && this._ctrl.isThermalActive());
        let tag = panel ? 'B' : 'A';
        if (active !== panel) {
            tag += 'X';
            console.warn('[StressTest] 导出标记为 ' + tag + '：面板 enableThermalControl=' + panel
                + '，但运行时温控' + (active ? '已开启' : '已关闭') + '，两者不一致');
        }
        const name = 'thermal_' + tag + '_' + Date.now() + '.csv';
        this._writeFile(name, this._rows.join('\n'), 'export');
        return name;
    }

    /**
     * 定时（60s）快照：**固定文件名覆盖写** thermal_latest.csv。
     * 原来的写法是每 60s 新建一个带时间戳的全量文件，30 分钟会留下 30 份（12 行、24 行……360 行）
     * 互相包含的副本，事后分不清该用哪份。固定名覆盖的代价是崩溃最多丢一个周期（60s），
     * 这正是 autoExport 的初衷；需要归档时用 exportCsv()。
     */
    public autoExport (): void {
        if (!this._ctrl.writeCsv) return;
        if (this._rows.length <= 1) return;
        const wx = this._getWx();
        if (!wx || !wx.getFileSystemManager) {
            console.log('[StressTest] CSV sampling (non-WeChat): ' + (this._rows.length - 1) + ' rows');
            return;
        }
        this._writeFile(CsvRecorder.LATEST_FILE, this._rows.join('\n'), 'auto');
    }

    /** 统一的落盘封装（export 与 autoExport 共用） */
    private _writeFile (name: string, data: string, kind: 'export' | 'auto'): void {
        const wx = this._getWx();
        const fs = wx.getFileSystemManager();
        const filePath = wx.env.USER_DATA_PATH + '/' + name;
        const rows = this._rows.length - 1;
        fs.writeFile({
            filePath: filePath,
            data: data,
            encoding: 'utf8',
            success: () => {
                if (kind === 'export') {
                    console.log('[StressTest] CSV exported: ' + filePath + ' (' + rows + ' rows)');
                } else {
                    console.log('[StressTest] CSV snapshot -> latest (' + rows + ' rows)');
                }
            },
            fail: (err: any) => {
                console.error('[StressTest] CSV write failed', err);
            }
        });
    }

    /**
     * 开跑前清理沙箱里上一次留下的**全部** `thermal_*.csv`（含 export 出来的归档）。
     *
     * 这是**预期行为**：每轮实验开始前把上一轮的文件清掉，否则多次重进后文件会一直堆积。
     * 取数顺序因此是"先导出/复制走，再重进"；`s('clean')` 可以不等重启手动清一次。
     */
    public cleanOld (): void {
        if (!this._ctrl.writeCsv) {
            console.log('[StressTest] writeCsv is off; skip cleanOldCsv');
            return;
        }
        const wx = this._getWx();
        if (!wx || !wx.getFileSystemManager || !wx.env) {
            console.log('[StressTest] cleanOldCsv: not in WeChat');
            return;
        }
        const fs = wx.getFileSystemManager();
        const dir = wx.env.USER_DATA_PATH;
        fs.readdir({
            dirPath: dir,
            success: (res: any) => {
                const names: string[] = (res.files || []).filter((n: string) => /^thermal_.*[.](csv|xls)$/.test(n));
                if (names.length === 0) {
                    this._ctrl._log('cleanOldCsv: 没有 thermal_*.csv');
                    return;
                }
                let pending = names.length;
                let removed = 0;
                const done = () => {
                    pending -= 1;
                    if (pending > 0) return;
                    this._ctrl._log('cleanOldCsv: removed ' + removed + '/' + names.length);
                    this._toast('清理旧CSV ' + removed + ' 个');
                };
                names.forEach((name: string) => {
                    fs.unlink({
                        filePath: dir + '/' + name,
                        success: () => {
                            removed += 1;
                            done();
                        },
                        fail: (err: any) => {
                            this._ctrl._log('cleanOldCsv unlink failed: ' + name + ' ' + JSON.stringify(err));
                            done();
                        }
                    });
                });
            },
            fail: (err: any) => {
                console.error('[StressTest] cleanOldCsv readdir failed', err);
                this._ctrl._log('cleanOldCsv readdir failed: ' + JSON.stringify(err));
            }
        });
    }

    /**
     * 把当前 5 秒窗口的统计压成一行 CSV。
     * fps_std 用的是"逐帧 FPS 的标准差"；两种掉帧率都按 DROP_TOLERANCE（5%）判，压掉 vsync/浮点噪声。
     * 判"真卡顿"仍看 jank_gt_2x（>2 倍预算）/ ft_p95 / ft_max。
     */
    private _flushRow (now: number): void {
        const frames = this._windowFrames;
        const n = frames.length;
        if (n === 0) return;
        let sum = 0;
        let max = 0;
        for (let i = 0; i < n; i++) {
            sum += frames[i];
            if (frames[i] > max) max = frames[i];
        }
        const avg = sum / n;
        const fps = 1000 / avg;
        this._lastFps = fps;
        if (this.onRow) this.onRow();     // 屏幕档位数字每 5 秒跟着刷新一次

        const sorted = frames.slice().sort((a, b) => a - b);
        const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
        const budget = this._baseBudgetMs;
        const budget2x = budget * 2;
        // T04：drop_rate 用的是"采样起点的固定预算"，跨温控阶段可比，但目标帧率本身被降到 30 之后，
        // 满载的 33.3ms 帧会被算成 100% 掉帧（看起来"温控后掉帧率反而暴涨"）。
        // 所以额外输出 drop_rate_cur：预算取**当前** game.frameRate，用于判断"当前档位下稳不稳"。
        const curBudget = 1000 / (Number(game.frameRate) || 60);
        // 两种掉帧率都带 5% 容差：VSYNC 抖动 + 浮点累加误差会让"满帧"也略超预算，
        // 不加容差时满帧 60fps 会报 ~59%、平稳 30fps 会报 100%（见 DROP_TOLERANCE 注释）。
        const dropLimit = budget * CsvRecorder.DROP_TOLERANCE;
        const dropLimitCur = curBudget * CsvRecorder.DROP_TOLERANCE;
        let jank = 0;
        let drop = 0;
        let dropCur = 0;
        let fpsSum = 0;
        let fpsSumSq = 0;
        for (let i = 0; i < n; i++) {
            if (frames[i] > budget2x) jank++;
            if (frames[i] > dropLimit) drop++;
            if (frames[i] > dropLimitCur) dropCur++;
            const f = 1000 / frames[i];
            fpsSum += f;
            fpsSumSq += f * f;
        }
        const meanFps = fpsSum / n;
        const fpsStd = Math.sqrt(Math.max(0, fpsSumSq / n - meanFps * meanFps));
        const dropRate = n > 0 ? (drop / n) * 100 : 0;
        const dropRateCur = n > 0 ? (dropCur / n) * 100 : 0;
        const pipeline = (director as any).root?.pipeline;
        const shadingScale = pipeline ? pipeline.shadingScale.toFixed(2) : 'NA';
        const elapsedS = (now - this._startTimestamp) / 1000;
        const row = [
            elapsedS.toFixed(1),
            Math.floor(now),
            fps.toFixed(1),
            avg.toFixed(2),
            p95.toFixed(2),
            max.toFixed(2),
            jank,
            this._getBatteryPct(),
            this._ctrl.planes.count,                 // load_gpu_layers：历史列名，场景 A 写"实际平面数"
            this._ctrl.cubes.count,                    // spawn_count：立方体数量
            shadingScale,
            String(game.frameRate),
            fpsStd.toFixed(2),
            dropRate.toFixed(1),
            dropRateCur.toFixed(1)                     // drop_rate_cur：相对"当前"目标帧率的掉帧率
        ].join(',');
        this._rows.push(row);
        console.log('[StressTest] ' + row);
    }

    /** 小游戏内弹一个 toast（非微信环境只打日志） */
    private _toast (msg: string): void {
        const wx = this._getWx();
        if (wx && typeof wx.showToast === 'function') {
            wx.showToast({ title: msg, icon: 'none', duration: 2500 });
        }
        console.log('[StressTest] ' + msg);
    }

    /** 取微信全局对象（编辑器预览里是 undefined） */
    private _getWx (): any {
        const g: any = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
        return g.wx;
    }

    /** 电量百分比，取不到返回 'NA'（编辑器预览必然是 NA） */
    private _getBatteryPct (): string {
        try {
            const wx = this._getWx();
            if (wx && wx.getBatteryInfoSync) {
                const info = wx.getBatteryInfoSync();
                if (info && typeof info.level === 'number') return String(info.level);
            }
        } catch (e) { }
        return 'NA';
    }
}
