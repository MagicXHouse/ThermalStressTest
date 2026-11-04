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
// drop_rate     超过预算的帧占比 %；满帧时因 vsync 抖动会恒在 60% 左右，参考价值低
// drop_rate     超过"采样起点预算"的帧占比 %。口径固定，跨温控阶段可比；但目标帧率被降档后
//               满载帧也会被算成掉帧，判"当前档位稳不稳"请用最后一列
// drop_rate_cur 超过"当前目标帧率（1000/game.frameRate）"的帧占比 %。温控降帧后它应当下降，
//               这是场景 B「温控后掉帧率下降」这条门槛的判据
export const CSV_HEADER = 'elapsed_s,ts_ms,fps,ft_avg_ms,ft_p95_ms,ft_max_ms,jank_gt_2x,battery_pct,load_gpu_layers,spawn_count,shading_scale,frame_rate,fps_std,drop_rate,drop_rate_cur';

export class CsvRecorder {
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
            this._windowFrames.push(now - this._lastFrameNow);
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

    /** 写入小游戏沙箱（wx.env.USER_DATA_PATH/thermal_<时间戳>.csv）；非微信环境只打日志 */
    public exportCsv (): void {
        if (!this._ctrl.writeCsv) {
            console.warn('[StressTest] writeCsv is off; skip file export');
            return;
        }
        if (this._rows.length <= 1) {
            console.warn('[StressTest] no CSV data');
            return;
        }
        const csv = this._rows.join('\n');
        const wx = this._getWx();
        if (wx && wx.getFileSystemManager) {
            const fs = wx.getFileSystemManager();
            const filePath = wx.env.USER_DATA_PATH + '/thermal_' + Date.now() + '.csv';
            fs.writeFile({
                filePath: filePath,
                data: csv,
                encoding: 'utf8',
                success: () => {
                    console.log('[StressTest] CSV exported: ' + filePath + ' (' + (this._rows.length - 1) + ' rows)');
                },
                fail: (err: any) => {
                    console.error('[StressTest] CSV write failed', err);
                }
            });
        } else {
            console.log('[StressTest] CSV sampling (non-WeChat): ' + (this._rows.length - 1) + ' rows');
        }
    }

    /** 开跑前清掉沙箱里上一次留下的 thermal_*.csv，避免文件越堆越多 */
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
                    this._ctrl._log('cleanOldCsv: no old thermal files');
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

    /** 定时（60s）自动导出一次，防止跑久了数据全在内存里丢失 */
    public autoExport (): void {
        if (!this._ctrl.writeCsv) return;
        if (this._rows.length <= 1) return;
        const wx = this._getWx();
        if (wx && wx.getFileSystemManager) {
            this.exportCsv();
        } else {
            console.log('[StressTest] CSV sampling (non-WeChat): ' + (this._rows.length - 1) + ' rows');
        }
    }

    /**
     * 把当前 5 秒窗口的统计压成一行 CSV。
     * fps_std 用的是"逐帧 FPS 的标准差"；drop_rate 在满帧时因 vsync 抖动会虚高到 60% 左右，
     * 判卡顿请优先看 jank_gt_2x / ft_p95 / ft_max。
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
        let jank = 0;
        let drop = 0;
        let dropCur = 0;
        let fpsSum = 0;
        let fpsSumSq = 0;
        for (let i = 0; i < n; i++) {
            if (frames[i] > budget2x) jank++;
            if (frames[i] > budget) drop++;
            if (frames[i] > curBudget) dropCur++;
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
