import { director } from 'cc';

/**
 * DRS（动态分辨率）A/B 循环：每 N 秒在 1.00 与 drsLowScale 之间切一次，并打印**上一档**的实测 fps。
 * 从 StressTestController 里拆出来的，行为与拆分前逐字一致。
 *
 * 定时用的是控制器的 Component.schedule/unschedule（本类只持有 ctrl 引用）。
 */
export class DrsProbe {
    private _ctrl: any;
    /** 当前是否处于"降分辨率"状态 */
    private _on = false;
    /** 当前实际写进 pipeline 的 shadingScale（用来打 1.00 → 0.30 这种切换日志） */
    private _scale = 1.0;
    /** 循环回调的稳定引用（unschedule 必须用同一个函数） */
    private _tick: (() => void) | null = null;

    constructor (ctrl: any) {
        this._ctrl = ctrl;
    }

    /**
     * 启动"每 N 秒切一次 DRS"的循环：先跑 10 秒满分辨率做基线，再切到低分辨率 10 秒，如此循环。
     * 每次切换都会打印**上一窗口**的实测 fps，所以控制台里能直接读出两档的差值；
     * CSV 的 shading_scale 列也会变成 1.00 / 0.30 的方波，事后画图就能对齐。
     *
     * 关于 FSR：FSR 跟随实际 shadingScale（降档就升采样），所以这个循环测到的是
     * "降分辨率 + 升采样"的组合收益；要单独看纯降分辨率，先 thermal.setFsrEnabled(false)。
     */
    public start (): void {
        this.stop();
        this._on = false;
        this._scale = 1.0;
        this.apply(false);                           // 从"不降"开始，先拿基线
        this._tick = () => this.apply(!this._on);
        this._ctrl.schedule(this._tick, Math.max(1, this._ctrl.drsToggleInterval));
        console.log('[StressTest] DRS 循环启动：shadingScale 在 1.00 和 ' + this._ctrl.drsLowScale.toFixed(2)
            + ' 之间切换，每 ' + this._ctrl.drsToggleInterval + 's 一次（stopDrsToggle() 停止）');
        if (!this._ctrl.drsLabel) {
            console.log('[StressTest] 想看屏幕上的档位数字就把一个 Label 拖到 Drs Label 槽');
        }
        console.log('[StressTest] 注：FSR 跟随实际 shadingScale 自动生效（降档就升采样）；'
            + '要做"纯降分辨率"的干净 A/B，先 thermal.setFsrEnabled(false)');
        if (this._ctrl.enableThermalControl) {
            console.warn('[StressTest] 温控也会写 shadingScale，会和这个循环抢；做 A/B 时请把 enableThermalControl 关掉');
        }
    }

    /** 停止 DRS 循环，并把分辨率还原到 1.0 */
    public stop (): void {
        if (!this._tick) return;
        this._ctrl.unschedule(this._tick);
        this._tick = null;
        if (this._scale < 1) {
            this._ctrl.setScale(1.0);
            this._scale = 1.0;
            this.updateLabel();
        }
        console.log('[StressTest] DRS 循环已停止，shadingScale 还原 1.00');
    }

    /**
     * 切一次 DRS：on → drsLowScale（默认 0.30），off → 1.00。
     * 日志直接写成 "1.00 → 0.30" 的形式，并带上**上一档**的实测 fps，
     * 所以只要看下面两行交替出现，就说明切换生效了：
     *   DRS 1.00 → 0.30 | 上一档实测 38.5fps (ft=25.97ms)
     *   DRS 0.30 → 1.00 | 上一档实测 58.4fps (ft=17.12ms)
     */
    public apply (on: boolean): void {
        this._on = on;
        const from = this._scale;
        const to = on ? this._ctrl.drsLowScale : 1.0;
        this._scale = to;

        this._ctrl.setScale(to);

        const fps = this._ctrl.csv.lastFps;
        const ft = fps > 0 ? (1000 / fps) : 0;
        console.log('[StressTest] DRS ' + from.toFixed(2) + ' → ' + to.toFixed(2)
            + (fps > 0 ? ' | 上一档实测 ' + fps.toFixed(1) + 'fps (ft=' + ft.toFixed(2) + 'ms)' : ' | 测基线中…'));
        this.updateLabel();
    }

    /** 屏幕上的档位显示：直接读 pipeline 的实际 shadingScale + 最近窗口 fps，所以温控改档时也是真的 */
    public updateLabel (): void {
        const label = this._ctrl.drsLabel;
        if (!label) return;
        const pipeline = (director as any).root?.pipeline;
        const scale = pipeline ? Number(pipeline.shadingScale) : this._scale;
        const fps = this._ctrl.csv.lastFps;
        label.string = 'shadingScale ' + scale.toFixed(2)
            + (fps > 0 ? '   ' + fps.toFixed(1) + ' fps' : '');
    }
}
