import {
    _decorator, Component, Node, Prefab, profiler, Enum,
    Label, Camera,
    director, game, thermal, cclegacy,
} from 'cc';
import { SliderBinder } from './SliderBinder';
import { CsvRecorder } from './csv-recorder';
import { HeatPlaneRig, TintMode } from './heat-plane';
import { ThermalBridge, DowngradeOrder } from './thermal-bridge';
import { DrsProbe } from './drs-probe';
import { CopyCsvButton } from './copy-csv-button';
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
 * 1. 场景 A 的 GPU 压测点必须由 3D 相机渲染：MeshRenderer，且不在 Canvas 下
 *    —— shadingScale 只缩放 3D 相机，Canvas(UI_2D) 走独立通道、按原生分辨率渲染。
 * 2. 场景 A 的 update() 不能有遍历/矩阵运算。这条由 spawnCount=0 保证；一旦开了立方体就是场景 B，
 *    那组数据不能再用来论证 GPU / DRS 收益。
 * 3. 场景 A 的负载必须重到能触发温控降档（60fps 目标下 avg ≥ 18.3ms，即 fps ≤ 54.5），
 *    否则温控永远不动，等于白测。
 *
 * ── 常用控制台入口（运行时挂在 globalThis.stressTest 上）────────────────────
 *   GPU: setHeatPlaneCount(0~8) / setPlaneCoverage(0.05~1)
 *   CPU: setSpawnCount(n) / setCpuWork(0~2000) / setPerCubeBaseOps(n)
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

    // ==================== 温控参数 ====================

    @property({ tooltip: '降档后允许的最低帧率。设成 60 = 钉住帧率（只让温控降分辨率）；45/40 这类非整数因子会被引擎回落到 30' })
    public thermalMinFrameRate: number = 30;

    @property({ tooltip: '降档触发阈值(%)：60fps 目标下 10% ⇒ 实测低于 54.5fps 才降档' })
    public thermalTriggerPercent: number = 10;

    @property({ tooltip: '分辨率地板：档位为 1.0 / 0.85 / 0.7 / 本值' })
    public thermalMinScale: number = 0.3;

    @property({ tooltip: '温控预热时长（秒），会传给 thermal.warmupSeconds；同时作为"延后开始采样"的时长，避免预热期污染 baseline' })
    public thermalWarmupSeconds: number = 20;

    @property({ tooltip: '降分辨率时是否开 FSR 升采样。关掉 = 纯降采样（更清晰度差但更省 GPU）；真机上若 FSR 开销盖过降采样收益，勾掉它' })
    public enableFsr: boolean = true;

    // ---- 试探式自动升档 ----

    @property({ tooltip: '是否启用试探式自动升档；false = 只降不升' })
    public enableAutoUpgrade: boolean = false;

    @property({ tooltip: '降档后到第一次自动试探升档的静默期（秒）' })
    public probeIntervalSeconds: number = 60;

    @property({ tooltip: '升档后观察多久判定成败（秒）；成功则立即继续下一档' })
    public recoveryProbeSeconds: number = 15;

    @property({ type: Enum(DowngradeOrder), tooltip: '降档顺序：ScaleFirst=先降分辨率（默认）/ FrameRateFirst=先降帧率（2D/UI 主导的游戏）' })
    public downgradeOrder: DowngradeOrder = DowngradeOrder.ScaleFirst;

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

    @property({ range: [0, 2000, 50], slide: true, tooltip: '每个立方体每帧额外做的浮点运算次数（0=关）。立方体数量不变时用它加大 CPU 负载' })
    public cpuWorkPerCube: number = 0;

    @property({ range: [0, 10000, 100], slide: true, tooltip: '每个立方体每帧的**基础**浮点运算次数。这是"数量越多 CPU 越重"的来源：每帧运算量 ≈ 数量 × (本值 + cpuWorkPerCube)。默认 4000，按 getStatus().cubeCpuMs 校准' })
    public perCubeBaseOps: number = 4000;

    // ==================== UI 引用 ====================

    @property(SliderBinder)
    public countSlider: SliderBinder | null = null;

    @property(SliderBinder)
    public gpuSlider: SliderBinder | null = null;

    // ==================== 复制CSV（可选 UI） ====================

    @property({ type: Node, tooltip: '（可选）编辑器里做好的"复制CSV"按钮节点；留空则运行时自动在左下角创建一个' })
    public copyButton: Node | null = null;

    @property({ type: Label, tooltip: '（可选）复制结果提示 Label；挂上后在 2 秒内显示"已复制 N 行"，之后自动清空' })
    public copyTipLabel: Label | null = null;

    @property({ tooltip: '没指定 copyButton 时，是否自动创建左下角"复制CSV"按钮' })
    public autoCreateCopyButton: boolean = true;

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

        // 复制CSV 的 UI：优先用编辑器里放好的按钮，否则运行时自动创建左下角按钮
        if (this.copyButton) {
            this.copyButton.on(Node.EventType.TOUCH_END, this.onCopyCsvClick, this);
        } else if (this.autoCreateCopyButton) {
            new CopyCsvButton(this).build();
        }
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
        console.log('  A/GPU: setHeatPlaneCount(1~8) 改叠层数 | setPlaneCoverage(0~1) 改单层面积');
        console.log('  B/CPU: setSpawnCount(n) | setCpuWork(0~2000) | setPerCubeBaseOps(n)');
        console.log('  drs  : startDrsToggle() | stopDrsToggle() | setScale(1|0.85|0.7|0.3) | thermalOn() | thermalOff()');
        console.log('  diag : diagFsr() | diagPlane() | getStatus() | logStatus() | exportCsv() | printCsv(n)');
        console.log('  命令通道（控制台看不到 stressTest 时用这个，微信任意上下文都行）:');
        console.log('    wx.setStorageSync(\'__stressCmd\', \'down\') / \'up\' / \'status\' / \'spawn:1500\' / \'scale:0.7\'');

        // 真机拿不到 performance.memory，只剩"内存告警"这个弱信号（level 5/10/15）。
        // 长测里如果频繁告警，说明内存在涨 —— 作为 J-03 的真机旁证。
        this._hookMemoryWarning();
    }

    /** 内存告警计数（真机 J-03 的旁证） */
    private _memWarnings = 0;

    private _hookMemoryWarning(): void {
        const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
        const wx = g.wx;
        if (!wx || typeof wx.onMemoryWarning !== 'function') return;
        try {
            wx.onMemoryWarning((res: any) => {
                this._memWarnings++;
                const lv = res && res.level;
                const name = lv === 5 ? '偏低' : lv === 10 ? '低' : '危急';
                this._log('内存告警 level=' + lv + '（' + name + '），累计 ' + this._memWarnings + ' 次');
            });
        } catch (e) {
            console.warn('[StressTest] wx.onMemoryWarning 注册失败');
        }
    }

    /**
     * 两套场景共用这一个 update()，靠 spawnCount 切换：
     * - spawnCount = 0 → 场景 A（纯 GPU）：立方体为空，下面这行调用立即返回，每帧只剩采样。
     * - spawnCount > 0 → 场景 B（CPU 负载）：逐立方体自转/浮动/公转/实例色，O(N)，CPU 抢走瓶颈。
     * 这是红线 2 的边界：A 的数据必须来自"没有这个循环"的那次运行，所以别在 A 的测试里开立方体。
     */
    update(dt: number) {
        this._pollCommands(dt);

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

    /** 把面板上留空的引用按名字补齐（HeatPlane / Plane） */
    private _resolveRefs() {
        const scene = this.node.scene;
        if (!this.heatPlane && scene) {
            this.heatPlane = this._findByName(scene, 'HeatPlane') || this._findByName(scene, 'Plane');
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

    // ==================== 对外接口 ====================

    /** 场景 B：立方体数量。0 = 回到场景 A（纯 GPU）。滑块和它双向同步 */
    public setSpawnCount(count: number, fromSlider: boolean = false) {
        this.spawnCount = Math.max(0, Math.floor(count));
        this.cubes.generate(this.spawnCount);
        if (!fromSlider && this.countSlider) {
            this.countSlider.setValue(this.spawnCount, true);
        }
    }

    /** 场景 B 的额外加压旋钮：每个立方体每帧**再**多做多少次浮点运算（0 = 只跑基础负载） */
    public setCpuWork(n: number) {
        this.cpuWorkPerCube = Math.max(0, Math.floor(n));
        const perCube = Math.floor(this.perCubeBaseOps + this.cpuWorkPerCube);
        console.log('[StressTest] cpuWorkPerCube = ' + this.cpuWorkPerCube
            + '（基础 ' + Math.floor(this.perCubeBaseOps) + ' + 额外 ' + this.cpuWorkPerCube
            + ' = ' + perCube + ' 次/立方体/帧；' + this.cubes.count + ' 个 → 约 '
            + (this.cubes.count * perCube) + ' 次浮点运算/帧）');
    }

    /** 场景 B 的基础负载：每个立方体每帧做多少次浮点运算（数量 × 本值 = 负载） */
    public setPerCubeBaseOps(n: number) {
        this.perCubeBaseOps = Math.max(0, Math.floor(n));
        const perCube = Math.floor(this.perCubeBaseOps + this.cpuWorkPerCube);
        console.log('[StressTest] perCubeBaseOps = ' + this.perCubeBaseOps
            + '（每立方体每帧 ' + perCube + ' 次；' + this.cubes.count + ' 个 → 约 '
            + (this.cubes.count * perCube) + ' 次/帧）');
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
        // 温控**当前真的开着**时手动改 scale：ScaleAction 自己记账（_currentScale），感知不到这次改动，
        // 它下一次升降档会基于旧值算档位，可能把 0.30 写回 0.85（反而升了分辨率）。所以要告警。
        // 注意判"实际状态"而不是面板开关：面板 enableThermalControl=true 但已经 thermalOff() 的情况下
        // 手动改 scale 是安全的，不该告警（之前就是这样误报的）。
        if (this.thermalBridge.isActive()) {
            console.warn('[StressTest] 注意：温控当前是开启状态，这次手动 setScale 会被它下一次升降档覆盖'
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

    /** 暂停采样与判定（加载期用）；resume 后会重新预热 */
    public thermalPause(): void { this.thermalBridge.pause(); }

    /** 恢复采样与判定（重新预热） */
    public thermalResume(): void { this.thermalBridge.resume(); }

    /**
     * 重载当前场景（或指定场景），用来验证"换场景后 FSR 缓存失效"（G-05）。
     *
     * 工程只有一个场景，所以用"重载同一个场景"来模拟换场景：所有节点会被销毁重建、
     * 相机是一个**新实例**——正是 `ThermalFsr._isCacheValid()` 要处理的"旧相机已销毁"路径。
     * 用 `scheduleOnce` 推迟一帧，避免在 update 回调里直接 loadScene。
     */
    public reloadScene(name?: string): void {
        const cur = director.getScene();
        const target = (name && name.length > 0) ? name : (cur ? cur.name : '');
        if (!target) {
            console.warn('[StressTest] reloadScene: 拿不到场景名');
            return;
        }
        console.log('[StressTest] reload scene -> ' + target + '（0.1s 后执行）');
        this.scheduleOnce(() => {
            director.loadScene(target, (err: Error | null) => {
                if (err) console.error('[StressTest] loadScene 失败: ' + err);
                else console.log('[StressTest] loadScene 完成: ' + target);
            });
        }, 0.1);
    }

    /** 手动降一档（走 ScaleAction 优先） */
    public thermalDown(): boolean { return this.thermalBridge.down(); }

    /** 手动升一档 */
    public thermalUp(): boolean { return this.thermalBridge.up(); }

    /** 读当前温控档位 */
    public thermalLevel(): number { return this.thermalBridge.level(); }

    /** 运行时改降档阈值（%），真机上调"多容易触发降档"，不用重新构建 */
    public setTriggerPercent(percent: number): void { this.thermalBridge.setTriggerPercent(percent); }

    /**
     * 运行时开关 FSR（不重新构建、不改变当前 shadingScale）。
     * 同档位 A/B：`thermalDown()` 到 0.85 → 记一段 → `setFsrEnabled(false)` → 再记一段，
     * 两段 ft_avg 的差就是 FSR 在该档的净开销。
     */
    public setFsrEnabled(enabled: boolean): void { this.thermalBridge.setFsrEnabled(enabled); }

    /** 运行时改 FSR 阈值（`shadingScale <= minScale` 才开），验证 0.85 档纯降采样是否更划算 */
    public setFsrMinScale(minScale: number): void { this.thermalBridge.setFsrMinScale(minScale); }

    /**
     * 运行时切换降档顺序（`'scale-first'` / `'frameRate-first'`，也接受面板枚举 0/1），不需要重新构建。
     * 只影响之后的降档；已经降过的档不会回滚。
     */
    public setDowngradeOrder(order: string | number): void { this.thermalBridge.setDowngradeOrder(order); }

    /** 引擎 thermal 门面（调试逃生口，可调 setFsrMaterial / getState 等未包装的 API） */
    public getThermal(): any { return this.thermalBridge.api(); }

    // ==================== 外部命令通道（微信各上下文都能驱动） ====================
    //
    // 背景：微信开发者工具的 Console 有时求值在别的上下文（例如开放数据域/SubContext），
    // 那里看不到 `stressTest`，直接敲函数名会 ReferenceError。
    // 但 **Storage 是同一小游戏实例共享的**，所以给它一条命令通道：
    //     游戏每 0.5s 读一次 __stressCmd，执行后清空
    //     控制台（任意上下文，只要有 wx）：
    //         wx.setStorageSync('__stressCmd', 'down')
    //         wx.setStorageSync('__stressCmd', 'spawn:1500')
    // 命令语法：`名字` 或 `名字:参数`，见 execCommand()。

    /** storage 里的命令键 */
    private static readonly CMD_KEY = '__stressCmd';
    /** 轮询累加（秒） */
    private _cmdAccum = 0;

    private _pollCommands(dt: number): void {
        this._cmdAccum += dt;
        if (this._cmdAccum < 0.5) return;
        this._cmdAccum = 0;

        const g: any = globalThis as any;
        const wxApi: any = g.wx;
        if (!wxApi || typeof wxApi.getStorageSync !== 'function') return;

        let cmd = '';
        try {
            cmd = String(wxApi.getStorageSync(StressTestController.CMD_KEY) || '');
        } catch (e) {
            return;
        }
        if (!cmd) return;
        try {
            wxApi.removeStorageSync(StressTestController.CMD_KEY);
        } catch (e) { /* 清不掉也没关系，下次会再执行一次 */ }

        try {
            const result = this.execCommand(cmd);
            // 命令的返回值对排查很有用（status/level/down 的 true|false），直接在日志里回显
            if (result !== undefined) {
                let text: string;
                try {
                    text = typeof result === 'object' ? JSON.stringify(result) : String(result);
                } catch (e) {
                    text = String(result);
                }
                console.log('[StressTest] result: ' + text);
            }
        } catch (e) {
            console.warn('[StressTest] 命令执行失败: ' + cmd + ' / ' + String(e));
        }
    }

    /**
     * 执行一条命令（也可以直接在能访问 stressTest 的地方调）。
     * 支持：
     *   down / up / on / off / status / print / level
     *   spawn:1500     planes:4          scale:0.7        fps:30
     *   trigger:30     order:frameRate-first               fsr:off
     *   fsrmin:0.7     cpu:1000          base:4000
     */
    public execCommand(cmd: string): any {
        const raw = String(cmd || '').trim();
        if (!raw) return;
        const idx = raw.indexOf(':');
        const name = (idx < 0 ? raw : raw.slice(0, idx)).trim();
        const arg = idx < 0 ? '' : raw.slice(idx + 1).trim();
        const num = Number(arg);

        console.log('[StressTest] exec: ' + raw);

        switch (name) {
            case 'down': case 'thermalDown': return this.thermalDown();
            case 'up': case 'thermalUp': return this.thermalUp();
            case 'on': case 'thermalOn': return this.thermalOn();
            case 'off': case 'thermalOff': return this.thermalOff();
            case 'pause': return this.thermalPause();
            case 'resume': return this.thermalResume();
            case 'reload': return this.reloadScene(arg);
            case 'status': return this.getStatus();
            case 'print': return this.printCsv(arg ? num : 10);
            case 'csvcheck': return this.csv.inspect();
            case 'mem': return this.memSnapshot();
            case 'export': return this.exportCsv();
            case 'copy': return this.copyCsv(num);
            case 'clean': return this.cleanOldCsv();
            case 'level': return this.thermalLevel();
            case 'spawn': case 'cubes': return this.setSpawnCount(num);
            case 'planes': return this.setHeatPlaneCount(num);
            case 'scale': return this.setScale(num);
            case 'fps': return this.setFps(num);
            case 'trigger': return this.setTriggerPercent(num);
            case 'cpu': return this.setCpuWork(num);
            case 'base': return this.setPerCubeBaseOps(num);
            case 'order': return this.setDowngradeOrder(arg);
            case 'fsr': return this.setFsrEnabled(arg !== 'off' && arg !== '0' && arg !== 'false');
            case 'fsrmin': return this.setFsrMinScale(num);
            case 'diag': return this.diagFsr();
            case 'diagplane': return this.diagPlane();
            case 'log': return this.logStatus();
            default:
                console.warn('[StressTest] 未知命令: ' + raw
                    + '；可用：down/up/on/off/status/print/level/diag/diagplane/log, '
                    + 'spawn:/planes:/scale:/fps:/trigger:/cpu:/base:/order:/fsr:/fsrmin:');
        }
    }

    // ==================== UI 回调 ====================

    /** 把 UI 同步成当前状态 */
    public refreshUI() {
        if (this.countSlider) {
            this.countSlider.setValue(this.spawnCount, true);
        }
        if (this.gpuSlider) {
            this.gpuSlider.setValue(this.heatPlaneCount, true);
        }
    }

    /** 返回一份状态快照（不打印），给外部脚本/日志用 */
    public getStatus() {
        const pipeline = (director as any).root?.pipeline;
        // thermal 可能被功能裁剪掉（cc.thermal === undefined），这里不能直接调 getState()
        const th: any = thermal as any;
        const state = th ? th.getState() : { level: -1, shadingScale: 1, frameRate: 0, enabled: false };
        return {
            mode: this.cubes.count > 0 ? 'B/CPU' : 'A/GPU',
            heatPlanes: this.planes.count,
            planeCoverage: Number(this.planeCoverage.toFixed(2)),
            gpuLayers: this.planes.count,
            cubes: this.cubes.count,
            /** 每帧浮点运算量 ≈ 数量 × (perCubeBaseOps + cpuWorkPerCube)，与 CPU 耗时应呈线性 */
            cubeOpsPerFrame: this.cubes.count * Math.floor(this.perCubeBaseOps + this.cpuWorkPerCube),
            /** 立方体脚本每帧的 CPU 耗时（毫秒）：判断"是不是真在压 CPU"，而不是靠立方体数量猜 */
            cubeCpuMs: {
                last: Number(this.cubes.lastMs.toFixed(2)),
                avg: Number(this.cubes.avgMs.toFixed(2)),
                perCubeUs: Number(this.cubes.perCubeUs.toFixed(2)),
            },
            cpuWorkPerCube: this.cpuWorkPerCube,
            fps: Number(this.csv.lastFps.toFixed(1)),
            frameRate: game.frameRate,
            shadingScale: pipeline ? Number(pipeline.shadingScale.toFixed(2)) : 'N/A',
            thermalLevel: state.level,
            thermalScale: Number(state.shadingScale),
            sampling: this.csv.sampling,
            csvRows: this.csv.rowCount,
            /** 采样期间被丢弃的"长间隔"个数（切后台/断点）；S-04 判据用 */
            csvGaps: this.csv.gaps,
            thermalOn: this.enableThermalControl,
            /** 运行时的实际状态（thermalOff 之后为 false，与面板开关无关） */
            thermalActive: this.thermalBridge.isActive(),
            /** 内存告警累计次数（真机 J-03 旁证；devtools 里一般是 0） */
            memWarnings: this._memWarnings,
            /** 当前降档顺序（面板值；运行时 setDowngradeOrder 会同步它） */
            downgradeOrder: this.downgradeOrder === DowngradeOrder.FrameRateFirst ? 'frameRate-first' : 'scale-first',
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

    /** 运行时温控是否真的开着（与面板开关无关） */
    public isThermalActive(): boolean { return this.thermalBridge.isActive(); }

    /** 本轮是否真的 enable 成功过（用于 A/B 导出标签：true = B 组） */
    public hasThermalEverBeenActive(): boolean { return this.thermalBridge.hasEverBeenActive(); }

    /** 写入小游戏沙箱；非微信环境只打日志。返回文件名（失败为 null） */
    public exportCsv(): string | null { return this.csv.exportCsv(); }

    /**
     * 把 CSV 复制到剪贴板，返回摘要 `{copied, rows, bytes}`。
     * @param lastN 只要最近 N 行；0 = 全部
     */
    public copyCsv(lastN: number = 0): any { return this.csv.copyCsv(lastN); }

    /**
     * 内存快照（J-03 用）。命令通道 `s('mem')`。
     *
     * 数据来自 `performance.memory`（Chromium 系才提供）：开发者工具的模拟器里有，
     * 真机微信基本没有 —— 所以 J-03 只能在开发者工具里做。返回值里带上 csvRows，
     * 方便区分"堆涨了"和"数据行涨了"（CSV 每 5 秒一行，30 分钟约 +29KB，属预期）。
     */
    public memSnapshot(): any {
        const perf: any = typeof performance !== 'undefined' ? performance : null;
        const m: any = perf && perf.memory;
        // 结构性快照：不依赖任何 API，任何环境都能拿。
        // 场景节点数只要不随时间上涨，就说明"没有越建越多的对象"（最常见的泄漏形态）。
        const structural = {
            sceneNodes: this._countSceneNodes(),
            cubes: this.cubes.count,
            planes: this.planes.count,
            csvRows: this.csv.rowCount,
            memWarnings: this._memWarnings,
        };
        if (!m || typeof m.usedJSHeapSize !== 'number') {
            return Object.assign({
                available: false,
                hint: '微信小游戏的逻辑跑在 Worker 里，没有 performance.memory；'
                    + '精确堆数据请看开发者工具 Memory 面板的堆快照。以下是结构性指标：',
            }, structural);
        }
        const mb = (n: number) => Number((n / 1048576).toFixed(1));
        const used = mb(m.usedJSHeapSize);
        const t = Number((performance.now() / 1000).toFixed(0));
        this._memSamples.push({ t, used });
        if (this._memSamples.length > 48) this._memSamples.shift();

        const first = this._memSamples[0];
        const last = this._memSamples[this._memSamples.length - 1];
        const all = this._memSamples.map(s => s.used);
        return Object.assign({
            available: true,
            usedMB: used,
            totalMB: mb(m.totalJSHeapSize),
            limitMB: mb(m.jsHeapSizeLimit),
            // 首次采样到现在的增量：正数就是"涨了"。配合 history 看是否单调
            deltaMB: this._memSamples.length > 1 ? Number((last.used - first.used).toFixed(1)) : 0,
            peakMB: Math.max(...all),
            // 紧凑历史：秒数:MB，例如 ["300:52.1","600:54.3"]
            history: this._memSamples.map(s => s.t + ':' + s.used),
        }, structural);
    }

    /** 统计场景里的节点总数（只在 s('mem') 被调用时遍历，不进逐帧路径） */
    private _countSceneNodes(): number {
        const scene: any = director.getScene();
        if (!scene) return 0;
        let n = 1;
        const stack: any[] = [scene];
        while (stack.length) {
            const cur = stack.pop();
            const children = cur && cur.children;
            if (!children) continue;
            for (let i = 0; i < children.length; i++) {
                n++;
                stack.push(children[i]);
            }
        }
        return n;
    }

    /** J-03 内存采样历史（最多 48 条，够 4 小时每 5 分钟一次） */
    private _memSamples: { t: number; used: number }[] = [];


    /**
     * 「复制CSV」按钮的统一入口（编辑器里的 Button 点击事件、运行时创建的按钮都指向它）。
     *
     * 做三件事：复制到剪贴板 → 弹 toast → 若有 `copyTipLabel` 则在 Label 上显示 2 秒。
     * 之所以统一到一个方法：面板、按钮、命令三处调用行为必须一致，否则排查时对不上。
     */
    public onCopyCsvClick(): void {
        const r = this.copyCsv(0);
        let msg = '复制失败（仅微信小游戏支持）';
        if (r && r.copied) {
            // 带上时长：一眼能核对"复制到的数据覆盖了多久"，也是 H-02 的现场判据
            msg = '已复制 ' + r.rows + ' 行（' + Math.round(r.span || 0) + 's）';
        } else if (r && r.reason === 'no-data') msg = '还没有数据';

        if (this.copyTipLabel) {
            this.copyTipLabel.string = msg;
            this.unschedule(this._clearCopyTip);
            this.scheduleOnce(this._clearCopyTip, 2);
        }
        const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
        const wx = g.wx;
        if (wx && typeof wx.showToast === 'function') {
            try { wx.showToast({ title: msg, icon: 'none', duration: 1500 }); } catch (e) { /* ignore */ }
        }
        console.log('[StressTest] ' + msg);
    }

    /** 2 秒后清空提示文字（保持引用稳定，才能被 unschedule 找到） */
    private _clearCopyTip = (): void => {
        if (this.copyTipLabel) this.copyTipLabel.string = '';
    };

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
