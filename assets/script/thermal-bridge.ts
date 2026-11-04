import { director, Material, resources, thermal } from 'cc';

/** 温控三级档位的可读名字，与引擎 ThermalLevel 对应（0/1/2） */
export const THERMAL_LEVEL_NAMES = ['Normal', 'Hot', 'Emergency'];

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
     */
    public initFsr (done: () => void): void {
        if (typeof (thermal as any).setFsrMaterial !== 'function') {
            console.warn('[StressTest] thermal.setFsrMaterial is unavailable; rebuild the custom engine to enable FSR.');
            done();
            return;
        }
        resources.load('fsr/builtin-fsr', Material, (err, material) => {
            if (err || !material) {
                console.error('[StressTest] FSR material load failed', err);
                done();
                return;
            }
            (thermal as any).setFsrMaterial(material);
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
            // 降分辨率时同时开 FSR 升采样（否则降档就是纯降采样，画面会糊）
            enableFsr: true,
        };
        thermal.enable(cfg);
        thermal.onLevelChange((level) => {
            console.log('[StressTest] thermal level changed -> ' + THERMAL_LEVEL_NAMES[level]);
        });
        if (typeof (thermal as any).onAction === 'function') {
            (thermal as any).onAction((e: any) => {
                c._log('thermal ' + e.direction + ' ' + e.lever + ' ' + e.from + ' -> ' + e.to
                    + ' level=' + e.level
                    + (e.avgMs && e.targetMs ? (' avg=' + e.avgMs.toFixed(2) + 'ms target=' + e.targetMs.toFixed(2) + 'ms') : ''));
            });
        }
        const state = thermal.getState();
        console.log('[StressTest] thermal ON: level=' + state.level
            + ', scale=' + Number(state.shadingScale).toFixed(2)
            + ', fps=' + state.frameRate
            + ', trigger=' + c.thermalTriggerPercent + '%'
            + ', FSR=' + (this._fsrReady ? 'READY' : 'PENDING'));
    }

    /** 关闭温控，帧率/分辨率还原 */
    public off (): void {
        thermal.disable();
        console.log('[StressTest] thermal OFF; frame rate and scale restored');
    }

    /** 手动降一档（走 ScaleAction 优先） */
    public down (): boolean {
        const ok = thermal.stepDown();
        console.log('[StressTest] manual thermal down: ' + (ok ? 'ok' : 'floor')
            + '; level=' + THERMAL_LEVEL_NAMES[thermal.getLevel()]);
        return ok;
    }

    /** 手动升一档 */
    public up (): boolean {
        const ok = thermal.stepUp();
        console.log('[StressTest] manual thermal up: ' + (ok ? 'ok' : 'top')
            + '; level=' + THERMAL_LEVEL_NAMES[thermal.getLevel()]);
        return ok;
    }

    /** 读当前温控档位 */
    public level (): number {
        const level = thermal.getLevel();
        console.log('[StressTest] thermal level: ' + THERMAL_LEVEL_NAMES[level] + ' (' + level + ')');
        return level;
    }

    /** 运行时改降档阈值（%），真机上调"多容易触发降档"，不用重新构建 */
    public setTriggerPercent (percent: number): void {
        this._ctrl.thermalTriggerPercent = percent;
        (thermal as any).setThreshold?.(percent);
        console.log('[StressTest] thermal triggerPercent = ' + percent + '%');
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

        // thermal 侧状态（内部字段，仅供调试）
        const fsrImpl: any = (thermal as any)._fsr;
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
