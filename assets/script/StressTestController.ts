import {
    _decorator, Component, Node, Prefab, profiler, Enum,
    Toggle, Label, Camera,
    director, game, thermal, cclegacy,
} from 'cc';
import { SliderBinder } from './SliderBinder';
import { CsvRecorder } from './csv-recorder';
import { HeatPlaneRig, TintMode } from './heat-plane';
import { ThermalBridge } from './thermal-bridge';
import { DrsProbe } from './drs-probe';
import { CpuCubes } from './cpu-cubes';
const { ccclass, property } = _decorator;

/**
 * 温控压测控制器：一个场景，两套压测，靠 spawnCount 切换。
 *
 * ── 场景 A（spawnCount = 0）—— 纯 GPU，验证"降分辨率(DRS)"的收益 ──────────────
 *   负载全部来自 3D 相机渲染目标上的一块（或多块叠加的）满屏平面，
 *   片元着色器是 64 次迭代的纯乘加依赖链，所以成本 ≈ 层数 × 像素量。
 *   update() 里只有帧时间采样，立方体为空 → 动画一次都不进（见 cpu-cubes.ts 的 early return）。
 *   GPU 负载滑块 = 叠加层数（0 = 关闭，1~8 = 几层全屏），颜色随层数蓝→红。
 *
 * ── 场景 B（spawnCount > 0）—— CPU 负载 ────────────────────────────────────
 *   每帧遍历 N 个立方体做自转/公转（+可选改实例颜色），O(N)。
 *   立方体数量或 cpuWorkPerCube 都能把 CPU 压过 16.7ms 预算。
 *
 * ── 三条红线 ──────────────────────────────────────────────────────────────
 * 1. 场景 A 的 GPU 压测点必须由 3D 相机渲染：MeshRenderer / ParticleSystem，且不在 Canvas 下
 *    —— shadingScale 只缩放 3D 相机，Canvas(UI_2D) 走独立通道、按原生分辨率渲染。
 * 2. 场景 A 的 update() 不能有遍历/矩阵运算。这条由 spawnCount=0 保证；一旦开了立方体就是场景 B，
 *    那组数据不能再用来论证 GPU / DRS 收益。
 * 3. 场景 A 的负载必须重到能触发温控降档（60fps 目标下 avg ≥ 18.3ms，即 fps ≤ 54.5），
 *    否则温控永远不动，等于白测。
 *
 * ── 常用控制台入口（运行时挂在 globalThis.stressTest 上）────────────────────
 *   GPU: setHeatPlaneCount(0~8) / setPlaneCoverage(0.05~1) / setParticleRate(n)
 *   CPU: setSpawnCount(n) / setCpuWork(0~2000) / setColorEnabled(bool)
 *   DRS: setScale(1|0.85|0.7|0.3) / thermalOn() / thermalOff() / thermalDown() / thermalUp()
 *   数据: exportCsv() / printCsv(n) / getStatus() / logStatus() / tintInfo()
 */

@ccclass('StressTestController')
export class StressTestController extends Component {

    // ==================== 通用开关 ====================

    @property({ tooltip: '代码温控开关：勾选=开温控，不勾=关温控（构建两个包做 A/B 对比）' })
    public enableThermalControl: boolean = false;

    @property({ tooltip: '是否把 CSV 结果写入手机文件' })
    public writeCsv: boolean = true;

    @property({ tooltip: '左下角显示 profiler（fps/drawcall/tris），CPU 成本可忽略，调参时很有用' })
    public showProfiler: boolean = true;

    // ==================== 场景 A 主负载：3D 满屏平面 ====================

    @property({ type: Node, tooltip: '满屏平面模板，对应场景里面的 HeatPlane' })
    public heatPlane: Node | null = null;

    @property({ range: [0, 8, 1], slide: true, tooltip: '平面层数：0 = 完全关掉 GPU 负载（平面隐藏、副本销毁）；N 层 ≈ N 倍全屏片元成本' })
    public heatPlaneCount: number = 1;

    @property({ range: [0.05, 1, 0.05], slide: true, tooltip: '单层覆盖比例（边长比，1=铺满全屏）。GPU 主旋钮是层数；这个留给"1 层都太重"时在 1 层之下做细调，像素 ∝ 比例²' })
    public planeCoverage: number = 1.0;

    @property({ type: Enum(TintMode), tooltip: '平面着色依据：Load=按层数(1层蓝→8层红，滑块反馈) / Pressure=按实测帧时间 / Off=不接管' })
    public tintMode: TintMode = TintMode.Load;

    @property({ range: [0.05, 1, 0.05], slide: true, tooltip: 'Pressure 模式灵敏度：帧时间超出预算多少比例算"全红"。0.4 = 超 40%' })
    public pressureRange: number = 0.4;

    @property({ tooltip: '由脚本把平面摆到相机正前方并缩放到铺满视野（推荐；关掉就完全用编辑器里手调的位置/缩放）' })
    public autoFitToCamera: boolean = true;

    @property({ tooltip: '自动摆位时平面到相机的距离（世界单位），需落在 near/far 之间' })
    public planeDistance: number = 15;

    @property({ range: [0, 0.5, 0.02], slide: true, tooltip: '自动摆位的边缘余量，避免降分辨率/FSR 后边缘露底' })
    public coverageMargin: number = 0.04;

    @property({ type: Node, tooltip: '3D 相机节点：留空则自动挑透视相机（Main Camera）' })
    public cameraNode: Node | null = null;

    // ==================== DRS 自动切换（验证"降分辨率到底回不回帧"） ====================

    @property({ tooltip: '每 N 秒自动切一次"降分辨率(+FSR)"，用来看帧率是否真的回升。默认关：它会和温控抢 shadingScale，开温控时必须保持关' })
    public autoToggleDrs: boolean = false;

    @property({ tooltip: '切换间隔（秒）。DRS 开 10s → 关 10s → 循环' })
    public drsToggleInterval: number = 10;

    @property({ range: [0.3, 1, 0.05], slide: true, tooltip: 'DRS 打开时用的 shadingScale（1 = 不降）。0.3 ≈ 9% 像素，画面会明显糊，帧率差也最直观' })
    public drsLowScale: number = 0.3;

    @property({ type: Label, tooltip: '（可选）屏幕上的档位显示：挂一个 Label，会实时显示 shadingScale 和 fps，一眼看出当前哪一档' })
    public drsLabel: Label | null = null;

    // ==================== 次要负载：粒子 ====================

    @property({ type: Node, tooltip: 'Particle 节点，留空按名字自动找' })
    public particleNode: Node | null = null;

    @property({ tooltip: '粒子发射速率（个/秒）；<0 表示不改动画布上调好的值' })
    public particleRate: number = -1;

    // ==================== 温控参数 ====================

    @property({ tooltip: '降档后允许的最低帧率' })
    public thermalMinFrameRate: number = 30;

    @property({ tooltip: '降档触发阈值(%)：60fps 目标下 10% ⇒ 实测低于 54.5fps 才降档' })
    public thermalTriggerPercent: number = 10;

    @property({ tooltip: '分辨率地板：档位为 1.0 / 0.85 / 0.7 / 本值' })
    public thermalMinScale: number = 0.3;

    @property({ tooltip: '温控预热时长（秒），会传给 thermal.warmupSeconds；同时作为"延后开始采样"的时长，避免预热期污染 baseline' })
    public thermalWarmupSeconds: number = 20;

    // ---- 试探式自动升档 ----

    @property({ tooltip: '是否启用试探式自动升档；false = 只降不升' })
    public enableAutoUpgrade: boolean = false;

    @property({ tooltip: '降档后到第一次自动试探升档的静默期（秒）' })
    public probeIntervalSeconds: number = 60;

    @property({ tooltip: '升档后观察多久判定成败（秒）；成功则立即继续下一档' })
    public recoveryProbeSeconds: number = 15;

    // ==================== 场景 B：CPU 负载（立方体，数量 0 时完全不影响场景 A） ====================

    @property(Prefab)
    public testObjectPrefab: Prefab | null = null;

    @property({ tooltip: '生成半径' })
    public spawnRadius: number = 20;

    @property({ tooltip: '立方体数量：0 = 场景 A（纯 GPU，每帧零遍历）；>0 = 场景 B（CPU 负载，每帧 O(N) 遍历）' })
    public spawnCount: number = 0;

    @property({ tooltip: '自转速度（度/秒）' })
    public rotationSpeed: number = 90;

    @property({ tooltip: '绕中心公转速度（度/秒）' })
    public orbitSpeed: number = 10;

    @property({ tooltip: '是否随机切换实例颜色（每 N 帧一次；会写 GPU 实例 buffer，CPU 成本随数量线性）' })
    public enableDynamicColor: boolean = false;

    @property({ tooltip: '颜色切换间隔（帧），越大 CPU 越轻松' })
    public colorSwitchInterval: number = 10;

    @property({ range: [0, 2000, 50], slide: true, tooltip: '每个立方体每帧额外做的浮点运算次数（0=关）。立方体数量不变时用它加大 CPU 负载' })
    public cpuWorkPerCube: number = 0;

    // ==================== UI 引用 ====================

    @property(SliderBinder)
    public countSlider: SliderBinder | null = null;

    @property(Toggle)
    public colorToggle: Toggle | null = null;

    @property(SliderBinder)
    public gpuSlider: SliderBinder | null = null;

    // ==================== 内部状态 ====================

    /** 场景 A 的平面负载装置（实现见 heat-plane.ts） */
    private planes!: HeatPlaneRig;

    /** 引擎 thermal 的接线层（实现见 thermal-bridge.ts） */
    private thermalBridge!: ThermalBridge;
    /** 场景 B 的立方体（实现见 cpu-cubes.ts） */
    private cubes!: CpuCubes;


    /** DRS A/B 循环（实现见 drs-probe.ts） */
    private drs!: DrsProbe;

    /** 帧时间采样 + CSV 记录（实现见 csv-recorder.ts） */
    private csv!: CsvRecorder;

    /** 启动时是否因"温控 + DRS 同时开"而强制关掉了 DRS（getStatus 会暴露它，用来判断数据是否干净） */
    private _drsConflictResolved = false;



    // ==================== 生命周期 ====================

    /** 绑定两条滑块（CPU 数量 / GPU 层数）并把引用解析成实际节点 */
    onLoad() {
        this.csv = new CsvRecorder(this);
        this.planes = new HeatPlaneRig(this);
        this.thermalBridge = new ThermalBridge(this);
        this.drs = new DrsProbe(this);
        this.cubes = new CpuCubes(this);
        this.csv.onRow = () => this._updateDrsLabel();
        if (this.countSlider) {
            this.countSlider.setValue(this.spawnCount, true);
            this.countSlider.onChange((v) => this.setSpawnCount(v, true));
        }
        if (this.gpuSlider) {
            // GPU 滑块 = 叠加层数，不碰 planeCoverage（覆盖率是独立旋钮，见下面的提示）
            this.gpuSlider.setValue(this.heatPlaneCount, true);
            this.gpuSlider.onChange((v) => this.setHeatPlaneCount(v));
        }
        // 覆盖率 < 1 表示单层没铺满全屏（刻意在 1 层之下做细调），启动时提示一句，但不改用户的值
        if (this.planeCoverage < 0.999) {
            console.log('[StressTest] 单层覆盖 = ' + this.planeCoverage.toFixed(2)
                + '（边长比，≈ ' + Math.round(this.planeCoverage * this.planeCoverage * 100) + '% 像素）'
                + '，平面未铺满全屏；要满屏就把 planeCoverage 设成 1');
        }
        this._resolveRefs();
        this._resolveDrsConflict();
    }

    /**
     * 互斥校验：温控和 DRS A/B 循环都会写 pipeline.shadingScale，同时开 = 互相覆盖。
     *
     * 为什么必须互斥：温控的 ScaleAction 自己记账（_currentScale 只在构造时读一次 pipeline），
     * 外部把 0.30 改成别的值它毫不知情；于是它下一次"降档"可能把 0.30 写成 0.85 —— 反而升了分辨率，
     * 同时 CSV 的 shading_scale 列变成两路混合的方波，这组数据不能用来论证温控效果。
     *
     * 处置：以温控为准，关掉 DRS，并且**大声报错**（不静默改配置，否则用户以为 DRS 还在工作）。
     * @returns 是否发生了冲突并已处置
     */
    private _resolveDrsConflict(): boolean {
        if (!this.enableThermalControl || !this.autoToggleDrs) return false;
        this.autoToggleDrs = false;
        this._drsConflictResolved = true;
        console.error('[StressTest] 配置冲突：enableThermalControl 与 autoToggleDrs 同时为 true，'
            + '两者都会写 pipeline.shadingScale（温控自己记账，不知道外部改过它）。'
            + '已按「温控优先」自动关闭 DRS；要做 DRS 的 A/B 对比，请把 enableThermalControl 关掉后重启。');
        return true;
    }

    /**
     * 负载生成只在这里（和手动调接口时）做一次，绝不放进 update()。
     * 顺序有讲究：先 FSR 材质就绪 → 再开温控 → **最后才开始采样**。
     * 采样必须在温控就绪之后启动，否则启动后那几秒"温控还没开"的帧会混进 CSV，
     * 污染"温控开启"组的 baseline（resources.load 是异步的，真机首屏慢时窗口更大）。
     */
    start() {
        if (this.showProfiler) profiler.showStats();

        this.cubes.generate(this.spawnCount);
        this.refreshUI();
        this.applyLoad();
        if (this.planes.count > 0) this.diagPlane();   // 只在启动时打一次，拖滑块不会刷屏

        // FSR 材质必须先就绪，否则第一次降分辨率会"糊着降"（没有升采样）
        this.thermalBridge.initFsr(() => {
            if (this.enableThermalControl) {
                this.thermalOn();
            } else {
                console.log('[StressTest] thermal OFF (enableThermalControl = false)');
            }

            const beginSampling = () => {
                // 采样与温控状态同生命周期：到这里温控才真正就绪
                this.csv.start();
                if (this.writeCsv) {
                    this.csv.cleanOld();
                    this.schedule(() => this.csv.autoExport(), 60);
                }
                // A/B 验证：每 N 秒切一次 DRS（默认开，验收长测时关掉）
                if (this.autoToggleDrs) this.startDrsToggle();
            };

            if (this.enableThermalControl && this.thermalWarmupSeconds > 0) {
                // 温控有预热期（thermal.warmupSeconds），这期间不会做任何动作。
                // 把这段排除在 CSV 之外，否则"已开温控但未动作"的前 N 秒会混进"温控开启"组的 baseline。
                console.log('[StressTest] 温控预热 ' + this.thermalWarmupSeconds
                    + 's 后才开始采样（预热期不计入 CSV）');
                this.scheduleOnce(beginSampling, this.thermalWarmupSeconds);
            } else {
                beginSampling();
            }
        });

        (globalThis as any).stressTest = this;
        console.log('[StressTest] attached to globalThis.stressTest');
        console.log('  A/GPU: setHeatPlaneCount(1~8) 改叠层数 | setPlaneCoverage(0~1) 改单层面积 | setParticleRate(n)');
        console.log('  B/CPU: setSpawnCount(n) | setCpuWork(0~2000) | setColorEnabled(true|false)');
        console.log('  drs  : startDrsToggle() | stopDrsToggle() | setScale(1|0.85|0.7|0.3) | thermalOn() | thermalOff()');
        console.log('  diag : diagFsr() | diagPlane() | getStatus() | logStatus() | exportCsv() | printCsv(n)');
    }

    /**
     * 两套场景共用这一个 update()，靠 spawnCount 切换：
     * - spawnCount = 0 → 场景 A（纯 GPU）：立方体为空，下面这行调用立即返回，每帧只剩采样。
     * - spawnCount > 0 → 场景 B（CPU 负载）：逐立方体自转/浮动/公转/实例色，O(N)，CPU 抢走瓶颈。
     * 这是红线 2 的边界：A 的数据必须来自"没有这个循环"的那次运行，所以别在 A 的测试里开立方体。
     */
    update(dt: number) {
        this.cubes.animate(dt);

        // Pressure 模式才需要逐帧采样；Load 模式（默认）颜色只跟层数走，这里零开销
        if (this.tintMode === TintMode.Pressure) {
            this.planes.tickPressureTint(dt);
        }

        this.csv.tick();
    }

    // ==================== 着色 —— 实现见 heat-plane.ts ====================

    /** 调试：当前着色算出了什么、材质有没有真的收到 */
    public tintInfo(): any { return this.planes.tintInfo(); }

    /** 调试：强制一个颜色，验证"颜色 → 材质 → 屏幕"链路 */
    public testTint(r: number, g: number, b: number, a = 0.6): void { this.planes.testTint(r, g, b, a); }

    /** 控制台切着色模式：'load'（默认）| 'pressure' | 'off' */
    public setTintMode(mode: string): void { this.planes.setTintMode(mode); }

    // ==================== 引用解析 ====================

    /** 把面板上留空的引用按名字补齐（HeatPlane / Plane / Particle） */
    private _resolveRefs() {
        const scene = this.node.scene;
        if (!this.heatPlane && scene) {
            this.heatPlane = this._findByName(scene, 'HeatPlane') || this._findByName(scene, 'Plane');
        }
        if (!this.particleNode && scene) {
            this.particleNode = this._findByName(scene, 'Particle');
        }
        if (!this.heatPlane) {
            console.error('[StressTest] 找不到平面：场景根节点下需要一块 MeshRenderer（建议命名 HeatPlane）');
        }
    }

    /** 按名字递归找节点（只在启动/改引用时用，别放进逐帧逻辑） */
    private _findByName(root: Node | null, name: string): Node | null {
        if (!root) return null;
        if (root.name === name) return root;
        const children = root.children;
        for (let i = 0; i < children.length; i++) {
            const found = this._findByName(children[i], name);
            if (found) return found;
        }
        return null;
    }

    /**
     * 找 3D 相机：优先用面板指定的 cameraNode；否则挑第一个**透视**相机
     * （Canvas 下的 UI 相机是正交的，正好被这句过滤掉）。
     */
    private _findCamera(): Camera | null {
        if (this.cameraNode) {
            const c = this.cameraNode.getComponent(Camera);
            if (c) return c;
        }
        const scene = this.node.scene;
        if (!scene) return null;
        const cams = scene.getComponentsInChildren(Camera);
        for (let i = 0; i < cams.length; i++) {
            if (cams[i].projection === Camera.ProjectionType.PERSPECTIVE) return cams[i];
        }
        return cams.length > 0 ? cams[0] : null;
    }

    // ==================== 负载生成 —— 实现见 heat-plane.ts ====================

    /** 重新生成平面层数 + 摆位 + 粒子速率 */
    public applyLoad(): void { this.planes.applyLoad(); }

    /** 平面自检：在不在视野、有没有网格、材质对不对 */
    public diagPlane(): boolean { return this.planes.diag(); }

    /** 诊断 FSR 链路 */
    public diagFsr() { return this.thermalBridge.diagFsr(); }

    /** GPU 负载滑块：叠加层数 0~8（不改平面大小） */
    public setHeatPlaneCount(count: number): void { this.planes.setCount(count); }

    /** 单层覆盖比例（1 层都太重时的细调旋钮） */
    public setPlaneCoverage(coverage: number): void { this.planes.setCoverage(coverage); }

    /** 粒子发射速率（次要负载，注意粒子模拟在 CPU） */
    public setParticleRate(rate: number): void { this.planes.setParticleRate(rate); }

    /** 开关粒子节点 */
    public setParticleActive(on: boolean): void { this.planes.setParticleActive(on); }

    // ==================== 对外接口 ====================

    /** 场景 B：立方体数量。0 = 回到场景 A（纯 GPU）。滑块和它双向同步 */
    public setSpawnCount(count: number, fromSlider: boolean = false) {
        this.spawnCount = Math.max(0, Math.floor(count));
        this.cubes.generate(this.spawnCount);
        if (!fromSlider && this.countSlider) {
            this.countSlider.setValue(this.spawnCount, true);
        }
    }

    /** 场景 B 的加压旋钮：每个立方体每帧额外做多少次浮点运算（0 = 关） */
    public setCpuWork(n: number) {
        this.cpuWorkPerCube = Math.max(0, Math.floor(n));
        console.log('[StressTest] cpuWorkPerCube = ' + this.cpuWorkPerCube
            + '（约 ' + (this.cubes.count * this.cpuWorkPerCube) + ' 次浮点运算/帧）');
    }

    /** 直接改帧率档（game.frameRate），用来对比 60/30 档的收益 */
    public setFps(fps: number) {
        game.frameRate = fps;
        console.log('[StressTest] frameRate = ' + fps + ' (readback ' + game.frameRate + ')');
    }

    /** 读当前帧率档 */
    public getFps(): string | number {
        return game.frameRate;
    }

    /**
     * 直接设渲染分辨率缩放（shadingScale），不经过温控，用来手动量"降分辨率能回多少帧"。
     * 注意：WebPipeline 的 setter 只写 pipelineSceneData，必须再调 forceResizeAllWindows 才会重建 RT，
     * 否则会出现"值变了但 RT 尺寸没变"。
     */
    public setScale(scale: number) {
        // 温控开着时手动改 scale：温控的 ScaleAction 自己记账（_currentScale），感知不到这次改动，
        // 它下一次升降档会基于旧值算档位，可能把 0.30 写回 0.85（反而升了分辨率）。所以明确告警。
        if (this.enableThermalControl) {
            console.warn('[StressTest] 注意：温控正在接管 shadingScale，这次手动 setScale 会被它下一次升降档覆盖'
                + '（ScaleAction 不知道外部改过）。要做干净的手动测试请先 thermalOff()。');
        }
        const root: any = (director as any).root;
        const pipeline = root?.pipeline;
        if (pipeline) {
            pipeline.shadingScale = scale;
        }
        cclegacy.rendering?.forceResizeAllWindows?.();
        console.log('[StressTest] shadingScale = ' + scale.toFixed(2)
            + ' (readback ' + (pipeline ? pipeline.shadingScale.toFixed(2) : 'N/A')
            + '), FSR=' + (this.thermalBridge.fsrReady ? 'READY' : 'PENDING'));
        this._updateDrsLabel();
    }

    /** 打一行当前状态（真机控制台里最常用的自查手段） */
    public logStatus() {
        const s: any = this.getStatus();
        console.log('[StressTest] status: ' + JSON.stringify(s));
        return s;
    }

    // ==================== DRS 自动切换 —— 实现见 drs-probe.ts ====================

    /** 启动"每 N 秒切一次 DRS"的 A/B 循环 */
    /** 启动"每 N 秒切一次 DRS"的 A/B 循环。温控开启时拒绝执行（两者会互相覆盖 shadingScale） */
    public startDrsToggle(): void {
        if (this.enableThermalControl) {
            console.error('[StressTest] 拒绝启动 DRS：温控正在接管 shadingScale，两者会互相覆盖（温控不知道外部改过它）。'
                + '先关掉 enableThermalControl 或调用 thermalOff() 再启动。');
            return;
        }
        this.drs.start();
    }

    /** 停止 DRS 循环，并把分辨率还原到 1.0 */
    public stopDrsToggle(): void { this.drs.stop(); }

    /** 屏幕上的档位显示（CSV 每出一行 / setScale 后刷新） */
    private _updateDrsLabel(): void { this.drs.updateLabel(); }

    // ==================== 温控 / FSR —— 实现见 thermal-bridge.ts ====================

    /** 开启温控 */
    public thermalOn() { this.thermalBridge.on(); }

    /** 关闭温控，帧率/分辨率还原 */
    public thermalOff() { this.thermalBridge.off(); }

    /** 手动降一档（走 ScaleAction 优先） */
    public thermalDown(): boolean { return this.thermalBridge.down(); }

    /** 手动升一档 */
    public thermalUp(): boolean { return this.thermalBridge.up(); }

    /** 读当前温控档位 */
    public thermalLevel(): number { return this.thermalBridge.level(); }

    /** 运行时改降档阈值（%），真机上调"多容易触发降档"，不用重新构建 */
    public setTriggerPercent(percent: number): void { this.thermalBridge.setTriggerPercent(percent); }

    // ==================== UI 回调 ====================

    /** 实例颜色开关（场景 B 用：每 colorSwitchInterval 帧给所有立方体换一次色） */
    public onColorToggleChanged(toggle: Toggle) {
        if (!toggle) return;
        this.enableDynamicColor = toggle.isChecked;
        console.log('[StressTest] dynamic color = ' + this.enableDynamicColor
            + (this.cubes.count === 0 ? '（当前没有立方体，无实际开销）' : '（' + this.cubes.count + ' 个立方体，开启后每帧线性增加 CPU）'));
    }

    /** 开关颜色变换（供控制台调用） */
    public setColorEnabled(enabled: boolean) {
        this.enableDynamicColor = enabled;
        if (this.colorToggle) this.colorToggle.isChecked = enabled;
        console.log('[StressTest] dynamic color = ' + (enabled ? 'ON' : 'OFF'));
    }

    /** 把 UI 同步成当前状态（避免启动时 Toggle 显示和实际不一致） */
    public refreshUI() {
        if (!this.colorToggle) return;
        if (this.colorToggle.isChecked !== this.enableDynamicColor) {
            // 赋值会触发 check 事件 → onColorToggleChanged，值是幂等的，安全
            this.colorToggle.isChecked = this.enableDynamicColor;
        }
    }

    /** 返回一份状态快照（不打印），给外部脚本/日志用 */
    public getStatus() {
        const pipeline = (director as any).root?.pipeline;
        const state = thermal.getState();
        return {
            mode: this.cubes.count > 0 ? 'B/CPU' : 'A/GPU',
            heatPlanes: this.planes.count,
            planeCoverage: Number(this.planeCoverage.toFixed(2)),
            gpuLayers: this.planes.count,
            cubes: this.cubes.count,
            cpuWorkPerCube: this.cpuWorkPerCube,
            particleRate: this.particleRate,
            fps: Number(this.csv.lastFps.toFixed(1)),
            frameRate: game.frameRate,
            shadingScale: pipeline ? Number(pipeline.shadingScale.toFixed(2)) : 'N/A',
            thermalLevel: state.level,
            thermalScale: Number(state.shadingScale),
            sampling: this.csv.sampling,
            csvRows: this.csv.rowCount,
            thermalOn: this.enableThermalControl,
            drsAutoToggle: this.autoToggleDrs,
            /** 启动时是否因"温控 + DRS 同时开"而强制关掉了 DRS：为 true 说明这组数据里没有 DRS 行为 */
            drsConflict: this._drsConflictResolved,
        };
    }

    // ==================== 帧时间自采（CSV）—— 实现见 csv-recorder.ts ====================

    /** 开始采集（每 5 秒一行） */
    public startLogging() { this.csv.start(); }

    /** 停止采集（已采集的行保留，仍可 exportCsv） */
    public stopLogging() { this.csv.stop(); }

    /** 把已采集的 CSV 打到控制台，lastN=0 表示全部 */
    public printCsv(lastN: number = 0) { this.csv.printCsv(lastN); }

    /** 写入小游戏沙箱；非微信环境只打日志 */
    public exportCsv() { this.csv.exportCsv(); }

    /** 开跑前清掉沙箱里上一次留下的 thermal_*.csv */
    public cleanOldCsv() { this.csv.cleanOld(); }

    /** 关键事件日志：同时进 console 和微信实时日志（真机不接调试器也能事后看） */
    private _log(msg: string) {
        console.log('[StressTest] ' + msg);
        const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
        const wx = g.wx;
        if (wx && typeof wx.getRealtimeLogManager === 'function') {
            try { wx.getRealtimeLogManager().info(msg); } catch (e) { /* ignore */ }
        }
    }
}
