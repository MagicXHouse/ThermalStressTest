import { director, Material, resources, thermal } from 'cc';

/** 温控三级档位的可读名字，与引擎 ThermalLevel 对应（0/1/2） */
export const THERMAL_LEVEL_NAMES = ['Normal', 'Hot', 'Emergency'];

/**
 * 取 thermal API；模块被功能裁剪掉时 `cc.thermal` 是 undefined。
 * 注意：不能写 `typeof thermal.setFsrMaterial === 'function'` —— thermal 为 undefined 时，
 * 这个成员访问本身就会抛 `TypeError: Cannot read properties of undefined`。
 */
function thermalApi (): any {
    const th: any = thermal as any;
    return th && typeof th.enable === 'function' ? th : null;
}

/**
 * 降档顺序预设（对应引擎 ThermalConfig.downgradeOrder）。
 * 只有开发商清楚自己的游戏对分辨率还是对帧率更敏感，所以这个是开放项。
 */
export enum DowngradeOrder {
    /** 先降分辨率（默认）：3D 画面为主、对糊不敏感的游戏 */
    ScaleFirst = 0,
    /** 先降帧率：2D/UI 为主、分辨率降了没用（Canvas 不跟着缩放）的游戏 */
    FrameRateFirst = 1,
}

/**
 * 引擎 thermal 模块的接线层：开关温控、手动升降档、改阈值、FSR 材质、FSR 链路诊断。
 * 从 StressTestController 里拆出来的，行为与拆分前逐字一致。
 *
 * 参数仍来自控制器的面板字段（thermalMinFrameRate / thermalTriggerPercent / …），
 * 所以本类只读 ctrl，不持有任何可调参数。
 */
export class ThermalBridge {
    /**
     * 本轮是否**真正** enable 成功过（模块存在且 enable 调通）。
     * 用途：A/B 导出文件名要按"温控有没有介入"打标签，而不是面板开关——
     * 典型反例：A 包面板勾着但 thermal feature 被裁掉，运行时不生效，它其实是 baseline。
     */
    private _everActive = false;
    private _ctrl: any;
    /** FSR 升采样材质是否就绪 */
    private _fsrReady = false;

    constructor (ctrl: any) {
        this._ctrl = ctrl;
    }

    public get fsrReady (): boolean { return this._fsrReady; }

    /**
     * 加载 FSR 材质（`assets/resources/fsr/builtin-fsr.mtl`，指向自定义管线用的 `fsr1.effect`），
     * 并交给 thermal（`setFsrMaterial`）。
     * thermal 模块被裁剪时直接跳过（不抛异常），保证"温控关"的包也能正常启动。
     */
    public initFsr (done: () => void): void {
        const th = thermalApi();
        if (!th || typeof th.setFsrMaterial !== 'function') {
            console.warn('[StressTest] thermal.setFsrMaterial is unavailable'
                + (th ? '（引擎版本过旧，需重新构建自定义引擎）' : '（thermal 模块被功能裁剪，构建时未启用 thermal feature）')
                + '；跳过 FSR，降分辨率将回退为普通降采样。');
            done();
            return;
        }
        resources.load('fsr/builtin-fsr', Material, (err, material) => {
            if (err || !material) {
                console.error('[StressTest] FSR material load failed', err);
                done();
                return;
            }
            th.setFsrMaterial(material);
            this._fsrReady = true;
            console.log('[StressTest] FSR material loaded: ' + material.name
                + ' effect=' + (material.effectAsset ? material.effectAsset.name : '<null>'));
            done();
        });
    }

    /**
     * 开启温控。杠杆顺序（引擎行为）：
     *   降档：先 shadingScale（场景 A 要验证的杠杆），scale 到地板后才降帧率；
     *   自动试探升档（enableAutoUpgrade=true）：先分辨率，scale 升满后再升帧率；
     *   手动 stepUp()：先帧率，再分辨率。
     * 触发条件：20s 滑动窗口的平均帧时间 ≥ 预算 × (1 + triggerPercent%)；
     * 另外前 thermalWarmupSeconds 秒是预热期，不会动作也不计入 CSV。
     */
    public on (): void {
        const c = this._ctrl;
        const th = thermalApi();
        if (!th) {
            console.error('[StressTest] thermal 模块不可用（构建时未启用 thermal feature）；'
                + '本次数据只能当作"温控关"用。要测温控请启用 thermal feature 重新构建。');
            return;
        }
        const cfg: any = {
            minFrameRate: c.thermalMinFrameRate,
            triggerPercent: c.thermalTriggerPercent,
            minScale: c.thermalMinScale,
            warmupSeconds: c.thermalWarmupSeconds,
            enableAutoUpgrade: c.enableAutoUpgrade,
            probeIntervalSeconds: c.probeIntervalSeconds,
            recoveryProbeSeconds: c.recoveryProbeSeconds,
            // 降档顺序是开放项：先降分辨率（默认）还是先降帧率，由面板决定
            downgradeOrder: c.downgradeOrder === DowngradeOrder.FrameRateFirst ? 'frameRate-first' : 'scale-first',
            enableScale: true,
            // 降分辨率时是否开 FSR 升采样，由面板 enableFsr 决定（关掉 = 纯降采样）。
            // 用 !== false 兜底：老场景没有这个属性时按"开"处理，行为与之前一致。
            enableFsr: c.enableFsr !== false,
        };
        th.enable(cfg);
        th.onLevelChange((level: number) => {
            console.log('[StressTest] thermal level changed -> ' + THERMAL_LEVEL_NAMES[level]);
        });
        if (typeof th.onAction === 'function') {
            th.onAction((e: any) => {
                c._log('thermal ' + e.direction + ' ' + e.lever + ' ' + e.from + ' -> ' + e.to
                    + ' level=' + e.level
                    + (e.avgMs && e.targetMs ? (' avg=' + e.avgMs.toFixed(2) + 'ms target=' + e.targetMs.toFixed(2) + 'ms') : ''));
            });
        }
        this._everActive = true;
        const state = th.getState();
        console.log('[StressTest] thermal ON: level=' + state.level
            + ', scale=' + Number(state.shadingScale).toFixed(2)
            + ', fps=' + state.frameRate
            + ', trigger=' + c.thermalTriggerPercent + '%'
            + ', FSR=' + (cfg.enableFsr ? (this._fsrReady ? 'READY' : 'PENDING') : 'OFF（面板已关，纯降采样）'));
    }

    /** 关闭温控，帧率/分辨率还原 */
    public off (): void {
        const th = thermalApi();
        if (th) th.disable();
        console.log('[StressTest] thermal OFF; frame rate and scale restored');
    }

    /**
     * 暂停采样与判定（加载期用）。暂停期间不会产生任何升降档动作；
     * `resume()` 会重新预热，避免把加载期的卡顿当成负载。
     */
    public pause (): void {
        const th = thermalApi();
        if (!th || typeof th.pause !== 'function') {
            console.warn('[StressTest] thermal.pause 不可用');
            return;
        }
        th.pause();
        console.log('[StressTest] thermal PAUSED（暂停采样与判定，resume 后重新预热）');
    }

    /** 恢复采样与判定；会重新走一遍预热窗口 */
    public resume (): void {
        const th = thermalApi();
        if (!th || typeof th.resume !== 'function') {
            console.warn('[StressTest] thermal.resume 不可用');
            return;
        }
        th.resume();
        console.log('[StressTest] thermal RESUMED（重新预热，预热期内不判定）');
    }

    /** 手动降一档（走 ScaleAction 优先） */
    public down (): boolean {
        const th = thermalApi();
        if (!th) return false;
        const ok = th.stepDown();
        console.log('[StressTest] manual thermal down: ' + (ok ? 'ok' : 'floor')
            + '; level=' + THERMAL_LEVEL_NAMES[th.getLevel()]);
        return ok;
    }

    /** 手动升一档 */
    public up (): boolean {
        const th = thermalApi();
        if (!th) return false;
        const ok = th.stepUp();
        console.log('[StressTest] manual thermal up: ' + (ok ? 'ok' : 'top')
            + '; level=' + THERMAL_LEVEL_NAMES[th.getLevel()]);
        return ok;
    }

    /** 引擎 thermal 门面（调试逃生口：控制台里能直接调引擎 API，比如 getThermal().setFsrMaterial(m)） */
    public api (): any {
        return thermalApi();
    }

    /**
     * 温控**当前是否真的处于 enabled 状态**（与面板开关 `enableThermalControl` 无关）。
     * 面板管的是"这个包构建时要不要开"，这里问的是"运行时现在开着没有"——
     * `thermalOff()` 之后就是 false，哪怕面板还是勾着的。
     */
    public isActive (): boolean {
        const th: any = thermalApi();
        const c: any = th && th._controller;
        return !!(c && c._enabled);
    }

    /** 本轮是否真的 enable 成功过（用于 A/B 导出标签） */
    public hasEverBeenActive (): boolean {
        return this._everActive;
    }

    /**
     * 运行时开关 FSR，不需要重新构建。
     *
     * 开关**不影响 shadingScale**：关闭只还原相机原来的 FSR 设置，当前档位不变。
     * 所以这是"同档位 A/B"最干净的做法：
     *   thermalDown() 到 0.85（FSR 自动开）→ 记 ft_avg → setFsrEnabled(false) → 再记 ft_avg
     * 两者之差就是 FSR 在这一档的净开销。
     */
    /**
     * 杠杆隔离（A/B 实验用）：只留一个杠杆。
     *   'scale'     → 只降分辨率（关掉帧率杠杆）
     *   'frameRate' → 只降帧率（关掉分辨率杠杆）
     *   'both'      → 两个都用（默认）
     * 引擎侧两个开关是独立的；分辨率/帧率的收益要分开量，否则会互相掩盖。
     */
    /** 当前杠杆范围（'scale' / 'frameRate' / 'both'），不影响引擎，只用于提示与状态展示 */
    private _leverScope = 'both';

    public leverScope (): string {
        return this._leverScope;
    }

    public setLeverScope (scope: string): void {
        this._leverScope = scope;
        const th: any = thermalApi();
        if (!th) {
            console.warn('[StressTest] thermal 不可用，无法设置杠杆范围');
            return;
        }
        const wantScale = scope !== 'frameRate';
        const wantFrame = scope !== 'scale';
        if (typeof th.setScaleEnabled === 'function') th.setScaleEnabled(wantScale);
        else console.warn('[StressTest] thermal.setScaleEnabled 不可用（引擎过旧）');
        if (typeof th.setFrameRateEnabled === 'function') th.setFrameRateEnabled(wantFrame);
        else console.warn('[StressTest] thermal.setFrameRateEnabled 不可用（引擎过旧，需重新构建自定义引擎）');
        console.log('[StressTest] 杠杆范围 = ' + scope
            + '（分辨率杠杆' + (wantScale ? '开' : '关') + '、帧率杠杆' + (wantFrame ? '开' : '关') + '）');
    }

    public setFsrEnabled (enabled: boolean): void {
        const th = thermalApi();
        if (!th || typeof th.setFsrEnabled !== 'function') {
            console.warn('[StressTest] thermal.setFsrEnabled 不可用（引擎版本过旧或被裁剪）');
            return;
        }
        th.setFsrEnabled(enabled);
        const fsrImpl: any = th._fsr;
        const settings: any = fsrImpl ? fsrImpl._settings : null;
        console.log('[StressTest] FSR = ' + (enabled ? 'ON' : 'OFF')
            + ' | scale=' + Number(th.getShadingScale()).toFixed(2)
            + ' | camera.fsr=' + (settings && settings.fsr
                ? (settings.fsr.enabled ? 'on' : 'off')
                : (fsrImpl ? 'no-settings' : 'no-impl')));
    }

    /**
     * 运行时改 FSR 阈值（`shadingScale <= minScale` 才开 FSR）。
     * 用来验证"0.85 档不开 FSR、0.70 档才开"是否更划算，同样不用重新构建。
     */
    public setFsrMinScale (minScale: number): void {
        const th = thermalApi();
        if (!th || typeof th.setFsrMinScale !== 'function') {
            console.warn('[StressTest] thermal.setFsrMinScale 不可用（引擎版本过旧或被裁剪）');
            return;
        }
        th.setFsrMinScale(minScale);
        console.log('[StressTest] fsrMinScale = ' + minScale
            + '（shadingScale <= ' + minScale + ' 才开 FSR）');
    }

    /** 读当前温控档位（模块被裁剪时返回 -1） */
    public level (): number {
        const th = thermalApi();
        if (!th) {
            console.log('[StressTest] thermal level: N/A（thermal 模块未启用）');
            return -1;
        }
        const level = th.getLevel();
        console.log('[StressTest] thermal level: ' + THERMAL_LEVEL_NAMES[level] + ' (' + level + ')');
        return level;
    }

    /** 运行时改降档阈值（%），真机上调"多容易触发降档"，不用重新构建 */
    public setTriggerPercent (percent: number): void {
        this._ctrl.thermalTriggerPercent = percent;
        thermalApi()?.setThreshold?.(percent);
        console.log('[StressTest] thermal triggerPercent = ' + percent + '%');
    }

    /**
     * 运行时切换降档顺序（`scale-first` / `frameRate-first`），不需要重新构建。
     *
     * - 新引擎（含 `Thermal.setDowngradeOrder`）：直接调门面；
     * - 旧引擎兜底：`_doStepDown` 每一步都读 `_config.downgradeOrder`，直接改它即可。
     * 只影响**之后**的降档；已经降过的档不会回滚。
     * 入参接受 `'frameRate-first'` / `'scale-first'`，也接受面板枚举 1 / 0。
     */
    public setDowngradeOrder (order: string | number): void {
        const th = thermalApi();
        if (!th) {
            console.warn('[StressTest] thermal 模块不可用，无法切换降档顺序');
            return;
        }
        const first = (order === 1 || order === 'frameRate-first' || order === 'framerate-first');
        const normalized = first ? 'frameRate-first' : 'scale-first';
        if (typeof th.setDowngradeOrder === 'function') {
            th.setDowngradeOrder(normalized);
        } else {
            const ctrlImpl: any = th._controller;
            if (!ctrlImpl || !ctrlImpl._config) {
                console.warn('[StressTest] setDowngradeOrder 不可用：既没有引擎 setter，也没有 controller._config');
                return;
            }
            ctrlImpl._config.downgradeOrder = normalized;
            console.log('[StressTest] downgradeOrder = ' + normalized + '（旧引擎兜底：直接改 controller._config）');
        }
        // 同步面板字段，getStatus().downgradeOrder 才能反映真实值
        this._ctrl.downgradeOrder = first ? DowngradeOrder.FrameRateFirst : DowngradeOrder.ScaleFirst;
        console.log('[StressTest] downgradeOrder 现在 = ' + normalized + '（只影响之后的降档）');
    }

    /**
     * 诊断 FSR 链路：打印“降分辨率 + FSR 到底有没有被写进相机设置”的关键状态。
     * 当前链路：thermal -> camera.pipelineSettings.fsr -> 自定义管线自带的 FSR pass。
     * 用法：控制台执行 `stressTest.diagFsr()`。
     */
    public diagFsr (): any {
        const out: any = {};

        const root: any = (director as any).root;
        const pipeline: any = root ? root.pipeline : null;
        out.pipelineClass = pipeline ? (pipeline.constructor ? pipeline.constructor.name : 'unknown') : 'null';
        out.pipelineShadingScale = pipeline ? Number((pipeline.shadingScale || 1).toFixed(3)) : 'n/a';
        // 发布包会压缩类名（实测 `WebPipeline` 变成 `e`），所以不能靠 pipelineClass 判断管线类型。
        // 自定义管线的标志是"它暴露了 shadingScale"，用鸭子类型判断，dev/preview/真机都可靠。
        out.pipelineSupportsShadingScale = !!(pipeline && typeof pipeline.shadingScale === 'number');
        // 是否"真的在按运行时 scale 缩放"。管线规则：pipeline.shadingScale !== 1 时运行时覆盖优先，
        // 会强制把相机的 enableShadingScale 置 true；否则才回落到组件上的静态配置。
        // 因此下面那个 enableShadingScale（组件字段）经常是 false，别拿它当"有没有缩放"。
        out.runtimeScaleActive = !!(pipeline && typeof pipeline.shadingScale === 'number' && pipeline.shadingScale !== 1);

        // 3D 相机：FSR 设置挂在 camera.pipelineSettings.fsr 上（由 BuiltinPipelineSettings 提供）
        const cam: any = this._ctrl._findCamera();
        const rc: any = cam && cam.camera ? cam.camera : null;
        out.cameraName = cam && cam.node ? cam.node.name : 'null';
        out.hasBuiltinPipelineSettings = !!(cam && cam.node && cam.node.getComponent('BuiltinPipelineSettings'));
        const settings: any = rc ? rc.pipelineSettings : null;
        out.hasPipelineSettings = !!settings;
        out.enableShadingScale = settings ? !!settings.enableShadingScale : 'n/a';
        out.settingsShadingScale = settings ? Number(settings.shadingScale) : 'n/a';
        out.fsr = settings && settings.fsr
            ? {
                enabled: !!settings.fsr.enabled,
                sharpness: Number(settings.fsr.sharpness),
                material: settings.fsr.material ? (settings.fsr.material.name || '<material>') : null,
                materialEffect: settings.fsr.material && settings.fsr.material.effectAsset
                    ? settings.fsr.material.effectAsset.name : null,
            }
            : null;

        // thermal 侧状态（内部字段，仅供调试）；模块被裁剪时为 null
        const th = thermalApi();
        const fsrImpl: any = th ? th._fsr : null;
        out.thermalFsr = fsrImpl
            ? {
                enabled: !!fsrImpl._enabled,
                minScale: fsrImpl._minScale,
                lastScale: fsrImpl._lastScale,
                warnedMaterial: !!fsrImpl._warnedMaterial,
                warnedComponent: !!fsrImpl._warnedComponent,
            }
            : null;

        console.log('[StressTest][diagFsr]\n' + JSON.stringify(out, null, 2));
        return out;
    }
}
