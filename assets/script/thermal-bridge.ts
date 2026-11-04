import { director, cclegacy, Material, resources, thermal } from 'cc';

/** 温控三级档位的可读名字，与引擎 ThermalLevel 对应（0/1/2） */
export const THERMAL_LEVEL_NAMES = ['Normal', 'Hot', 'Emergency'];

/**
 * 引擎 thermal 模块的接线层：开关温控、手动升降档、改阈值、FSR 材质占位、FSR 链路诊断。
 * 从 StressTestController 里拆出来的，行为与拆分前逐字一致。
 *
 * 参数仍来自控制器的面板字段（thermalMinFrameRate / thermalTriggerPercent / …），
 * 所以本类只读 ctrl，不持有任何可调参数。
 */
export class ThermalBridge {
    private _ctrl: any;
    /** FSR 升采样材质是否就绪（一期只加载占位，不真正启用） */
    private _fsrReady = false;

    constructor (ctrl: any) {
        this._ctrl = ctrl;
    }

    public get fsrReady (): boolean { return this._fsrReady; }

    /**
     * 一期纯降分辨率，不启用 FSR。此方法仅加载材质占位，二期启用 FSR 时再挂接。
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
            console.log('[StressTest] FSR material loaded (phase-1 unused, pure downsampling): ' + material.name);
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
            enableScale: true,
            enableFsr: false,
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
     * 诊断 FSR 链路（custom pipeline 探针）：一次性把"降分辨率 + FSR 到底走哪条链路"的关键状态
     * 全打出来。用来回答：thermal 写的 pipeline.shadingScale，和 custom pipeline 的 PostProcess/FSR
     * 组件之间有没有联动、FSR 会不会真的升采样。
     * 用法：编辑器预览里执行 `stressTest.diagFsr()` 。
     */
    public diagFsr (): any {
        const out: any = {};

        // ① 当前管线类型
        const root: any = (director as any).root;
        const pipeline: any = root ? root.pipeline : null;
        out.pipelineClass = pipeline ? (pipeline.constructor ? pipeline.constructor.name : 'unknown') : 'null';
        out.pipelineShadingScale = pipeline ? Number((pipeline.shadingScale || 1).toFixed(3)) : 'n/a';

        // ② 3D 相机及其 usePostProcess 状态
        const cam = this._ctrl._findCamera();
        out.cameraName = cam ? cam.node.name : 'null';
        out.cameraUsePostProcess = cam ? !!(cam as any).usePostProcess : 'n/a';

        // ③ PostProcess 组件（custom pipeline 的 FSR 必须挂在它上面）
        const ppNode = cam ? cam.node : null;
        const pp: any = ppNode ? ppNode.getComponent('cc.PostProcess') : null;
        out.hasPostProcess = !!pp;
        if (pp) {
            out.postProcessShadingScale = Number((pp.shadingScale || 1).toFixed(3));
            out.postProcessGlobal = !!pp.global;
            out.postProcessEnabled = pp.enabledInHierarchy;
            // FSR 是 PostProcessSetting 子类，onEnable 时会把自己 addSetting 进这个 Map。
            // 组件挂上了但这里是 0，说明 FSR 没注册进 PostProcess，pass 不会执行。
            out.postProcessSettingsCount = pp.settings ? pp.settings.size : 'n/a';
        }

        // ④ FSR 组件（PostProcessSetting 子类，requireComponent(PostProcess)，同节点）
        const fsr: any = ppNode ? ppNode.getComponent('cc.FSR') : null;
        out.hasFSR = !!fsr;
        if (fsr) {
            out.fsrSharpness = Number((fsr.sharpness || 0).toFixed(3));
            out.fsrEnabled = fsr.enabledInHierarchy;
        }

        // ⑤ render-scene camera 上的 postProcess 字段（post-process-builder 读的是它）
        if (cam) {
            const rc: any = (cam as any).camera;
            out.renderCameraPostProcess = rc && rc.postProcess
                ? 'set(' + (rc.postProcess.constructor ? rc.postProcess.constructor.name : 'unknown') + ')'
                : 'null';
            out.renderCameraUsePostProcess = rc ? !!rc.usePostProcess : 'n/a';
        }

        // ⑥ PostProcess.all 静态数组（global PP 探测）
        try {
            const ccAny: any = cclegacy;
            const PPCls: any = ccAny && ccAny.PostProcess;
            if (PPCls && Array.isArray(PPCls.all)) {
                out.postProcessAllCount = PPCls.all.length;
                out.postProcessAll = PPCls.all.map((p: any) => ({
                    global: !!p.global,
                    enabled: p.enabledInHierarchy,
                    node: p.node ? p.node.name : 'null',
                }));
            } else {
                out.postProcessAll = 'cc.PostProcess 类型不可达（可能未导出或未挂载）';
            }
        } catch (e) {
            out.postProcessAllError = String(e);
        }

        console.log('[StressTest][diagFsr]\n' + JSON.stringify(out, null, 2));
        return out;
    }
}
