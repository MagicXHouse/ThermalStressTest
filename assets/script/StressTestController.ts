import {
    _decorator, Component, Node, Prefab, instantiate, profiler, Enum,
    Toggle, Label, Vec3, Vec4, Quat, Color, MeshRenderer, ParticleSystem, Camera, Canvas, Layers,
    director, screen, game, thermal, cclegacy, Material, resources,
} from 'cc';
import { SliderBinder } from './SliderBinder';
import { CsvRecorder } from './csv-recorder';
import { HeatPlaneRig } from './heat-plane';
const { ccclass, property } = _decorator;

/** HeatPlane 的着色依据 */
enum TintMode {
    /** 按层数（默认）：1 层蓝 → 8 层红。用于确认 GPU 负载滑块真的生效了 */
    Load = 0,
    /** 按实测帧时间：预算内蓝，超预算压力Range 红。用于观察温控降分辨率是否真的把压力降下来 */
    Pressure = 1,
    /** 不接管颜色，用材质里手调的颜色 */
    Off = 2,
}

/**
 * 温控压测控制器：一个场景，两套压测，靠 spawnCount 切换。
 *
 * ── 场景 A（spawnCount = 0）—— 纯 GPU，验证"降分辨率(DRS)"的收益 ──────────────
 *   负载全部来自 3D 相机渲染目标上的一块（或多块叠加的）满屏平面，
 *   片元着色器是 64 次迭代的纯乘加依赖链，所以成本 ≈ 层数 × 像素量。
 *   update() 里只有帧时间采样，currentObjects 为空 → 立方体动画一次都不进。
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

    @property({ tooltip: '每 N 秒自动切一次"降分辨率(+FSR)"，用来看帧率是否真的回升。验收跑长测时记得关掉' })
    public autoToggleDrs: boolean = true;

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
    /** 场景 B 的立方体节点 */
    private currentObjects: Node[] = [];
    /** 颜色切换节流计数（帧） */
    private _frameCounter: number = 0;
    /** 吸收 cpuWorkPerCube 的计算结果，防止 JIT 把循环优化掉 */
    private _cpuSink: number = 0;

    // ---- 压力着色（Pressure 模式）与层数着色（Load 模式）共用 ----
    /** 帧时间指数滑动平均（ms），只有 Pressure 模式会更新 */
    private _ftEma: number = 0;
    /** 着色刷新节流（秒），4Hz */
    private _tintTimer: number = 0;
    /** 缓存 HeatPlane 的 sharedMaterial（所有副本共用这一个资产） */
    private _tintMat: Material | null = null;
    private _tintR: number = 255;
    private _tintG: number = 89;
    private _tintB: number = 26;
    /** 单层 alpha（写材质时会按层数再除一次，做叠加补偿） */
    private _tintA: number = 0.55;
    /** Pressure 模式算出的压力值 0~1 */
    private _pressureP: number = 0;

    // ---- DRS 自动切换 ----
    /** 当前是否处于"降分辨率"状态 */
    private _drsOn: boolean = false;
    /** 当前实际写进 pipeline 的 shadingScale（用来打 1.00 → 0.30 这种切换日志） */
    private _drsScale: number = 1.0;
    /** 循环回调的稳定引用（unschedule 必须用同一个函数） */
    private _drsTick: (() => void) | null = null;

    /** 帧时间采样 + CSV 记录（实现见 csv-recorder.ts） */
    private csv!: CsvRecorder;

    /** FSR 升采样材质是否就绪 */
    private _fsrReady: boolean = false;


    // ==================== 生命周期 ====================

    /** 绑定两条滑块（CPU 数量 / GPU 层数）并把引用解析成实际节点 */
    onLoad() {
        this.csv = new CsvRecorder(this);
        this.planes = new HeatPlaneRig(this);
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
    }

    /**
     * 负载生成只在这里（和手动调接口时）做一次，绝不放进 update()。
     * 顺序有讲究：先 FSR 材质就绪 → 再开温控 → **最后才开始采样**。
     * 采样必须在温控就绪之后启动，否则启动后那几秒"温控还没开"的帧会混进 CSV，
     * 污染"温控开启"组的 baseline（resources.load 是异步的，真机首屏慢时窗口更大）。
     */
    start() {
        if (this.showProfiler) profiler.showStats();

        this.generateObjects(this.spawnCount);
        this.refreshUI();
        this.applyLoad();
        if (this.planes.count > 0) this.diagPlane();   // 只在启动时打一次，拖滑块不会刷屏

        // FSR 材质必须先就绪，否则第一次降分辨率会"糊着降"（没有升采样）
        this._initFsr(() => {
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
     * - spawnCount = 0 → 场景 A（纯 GPU）：currentObjects 为空，下面的循环一次都不进，每帧只剩 3 行采样。
     * - spawnCount > 0 → 场景 B（CPU 负载）：逐立方体自转/浮动/公转/实例色，O(N)，CPU 抢走瓶颈。
     * 这是红线 2 的边界：A 的数据必须来自"没有这个循环"的那次运行，所以别在 A 的测试里开立方体。
     */
    update(dt: number) {
        const objects = this.currentObjects;
        if (objects.length > 0) {
            this._animateCubes(objects, dt);
        }

        // Pressure 模式才需要逐帧采样；Load 模式（默认）颜色只跟层数走，这里零开销
        if (this.tintMode === TintMode.Pressure) {
            this._updatePressureTint(dt);
        }

        this.csv.tick();
    }

    /**
     * 场景 B 的 CPU 负载主体：每帧遍历所有立方体，改 transform（+可选改实例颜色）。
     * 这就是"CPU 瓶颈"的来源：N 个立方体 = N 次 euler/position 写入 + N 次引擎侧世界矩阵更新。
     */
    private _animateCubes(objects: Node[], dt: number): void {
        const len = objects.length;
        const rotSpeed = this.rotationSpeed * dt;
        const orbitRad = this.orbitSpeed * Math.PI / 180 * dt;
        const rotSpeedY = rotSpeed * 0.7;
        const rotSpeedZ = rotSpeed * 0.3;
        const work = Math.max(0, Math.floor(this.cpuWorkPerCube));

        this._frameCounter++;
        const doColorSwitch = this.enableDynamicColor
            && (this.colorSwitchInterval <= 0 || this._frameCounter % this.colorSwitchInterval === 0);

        for (let i = 0; i < len; i++) {
            const obj = objects[i];
            if (!obj || !obj.isValid) continue;

            // 自转
            const euler = obj.eulerAngles;
            obj.eulerAngles = new Vec3(
                euler.x + rotSpeed,
                euler.y + rotSpeedY,
                euler.z + rotSpeedZ
            );

            // 公转（已去掉上下浮动：抖动刺眼，floatAmplitude/floatFrequency 两个属性已删除，Y 保持不变）
            const pos = obj.position;
            const radius = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
            const angle = Math.atan2(pos.z, pos.x) + orbitRad;
            obj.setPosition(Math.cos(angle) * radius, pos.y, Math.sin(angle) * radius);

            // 实例化颜色变换（写 GPU 实例 buffer，CPU 侧同样随数量线性）
            if (doColorSwitch) {
                const model = obj.getComponent(MeshRenderer);
                if (model) {
                    model.setInstancedAttribute('a_instanced_color', [
                        Math.floor(Math.random() * 256),
                        Math.floor(Math.random() * 256),
                        Math.floor(Math.random() * 256),
                        255
                    ]);
                }
            }

            // 可选：纯浮点负载，用来在立方体数量不变时继续加压（结果写进字段，防止被优化掉）
            if (work > 0) {
                let acc = this._cpuSink + i;
                for (let k = 0; k < work; k++) {
                    acc = acc * 1.0000001 + 0.5;
                }
                this._cpuSink = acc % 1000;
            }
        }
    }

    /**
     * 统一入口：按 tintMode 算出 p（0=蓝, 1=红）再写材质。
     * - Load 模式：p 只由层数决定（1 层=0，8 层=1）→ 拖滑块立刻变色，跟帧率无关，纯 UI 反馈。
     * - Pressure 模式：p 由实测帧时间决定 → 能看出温控降分辨率是否真的把压力降下来。
     */
    private _updateTint(): void {
        const mode = this.tintMode;
        if (mode === TintMode.Off) return;

        let p: number;
        if (mode === TintMode.Load) {
            p = (Math.max(1, this.planes.count) - 1) / 7;
        } else {
            p = this._pressureP;
        }
        p = p < 0 ? 0 : (p > 1 ? 1 : p);

        this._tintR = Math.round(40 + 215 * p);
        this._tintG = Math.round(120 - 95 * p);
        this._tintB = Math.round(255 - 220 * p);
        this._tintA = 0.45 + 0.33 * p;
        this._applyTint();
    }

    /** Pressure 模式才会用到的逐帧采样（Load 模式下 update 根本不调用它） */
    private _updatePressureTint(dt: number): void {
        const ftMs = Math.min(dt * 1000, 100);   // 首帧/长卡顿钳制，避免闪一下红
        this._ftEma = this._ftEma > 0 ? this._ftEma * 0.9 + ftMs * 0.1 : ftMs;

        this._tintTimer += dt;
        if (this._tintTimer < 0.25) return;      // 4Hz 足够，省掉无谓的 uniform 写入
        this._tintTimer = 0;

        const budget = 1000 / (Number(game.frameRate) || 60);
        const range = Math.max(0.05, this.pressureRange);
        const p = (this._ftEma / budget - 1) / range;
        this._pressureP = p < 0 ? 0 : (p > 1 ? 1 : p);
        this._updateTint();
    }

    /**
     * 写材质颜色。关键是**按层数做 alpha 补偿**：N 层加法混合时每层 alpha 除以 N，
     * 总亮度保持不变，颜色才不会被叠成纯白，蓝→红的读数在任何层数下都一致。
     */
    private _applyTint(): void {
        if (this.tintMode === TintMode.Off) return;
        const mat = this._tintMaterial();
        if (!mat) return;
        const layers = Math.max(1, this.planes.count);
        const a = Math.max(8, Math.min(255, Math.round(this._tintA * 255 / layers)));
        mat.setProperty('heatTint', new Color(this._tintR, this._tintG, this._tintB, a));
    }

    /** 调试：当前着色到底算出了什么、材质有没有真的收到。 */
    public tintInfo() {
        const mat = this._tintMaterial();
        const got: any = mat ? mat.getProperty('heatTint', 0) : null;
        const budget = 1000 / (Number(game.frameRate) || 60);
        const loadP = (Math.max(1, this.planes.count) - 1) / 7;
        const info = {
            tintMode: TintMode[this.tintMode],
            layers: this.planes.count,
            computedP: Number((this.tintMode === TintMode.Load ? loadP : this._pressureP).toFixed(3)),
            ftEmaMs: Number(this._ftEma.toFixed(2)),
            budgetMs: Number(budget.toFixed(2)),
            computedRGB: [this._tintR, this._tintG, this._tintB],
            material: mat ? mat.name : 'NULL',
            materialHeatTint: got ? { r: got.r, g: got.g, b: got.b, a: got.a } : 'NULL',
        };
        console.log('[StressTest] tintInfo: ' + JSON.stringify(info));
        return info;
    }

    /**
     * 调试：强制一个颜色，用来验证"颜色 → 材质 → 屏幕"这条链路是否通。
     * 会切成 Off 模式，检查完记得 stressTest.setTintMode('load') 恢复。
     */
    public testTint(r: number, g: number, b: number, a = 0.6) {
        this.tintMode = TintMode.Off;
        const mat = this._tintMaterial();
        if (!mat) { console.error('[StressTest] testTint: 拿不到材质'); return; }
        mat.setProperty('heatTint', new Color(r, g, b, Math.round(a * 255)));
        const got: any = mat.getProperty('heatTint', 0);
        console.log('[StressTest] testTint -> rgb(' + r + ',' + g + ',' + b + '), 材质实际值=' +
            (got ? 'rgb(' + got.r + ',' + got.g + ',' + got.b + ') a=' + got.a : 'NULL') +
            '（已切到 Off，恢复：stressTest.setTintMode(\'load\')）');
    }

    /** 控制台切着色模式：'load'（默认，按层数）| 'pressure'（按实测帧时间）| 'off' */
    public setTintMode(mode: string) {
        const m = String(mode).toLowerCase();
        this.tintMode = m === 'pressure' ? TintMode.Pressure
            : (m === 'off' ? TintMode.Off : TintMode.Load);
        this._updateTint();
        console.log('[StressTest] tintMode = ' + TintMode[this.tintMode]);
    }

    /** 取 HeatPlane 的材质并缓存（用 sharedMaterial：所有副本共用同一个资产，改一次全变） */
    private _tintMaterial(): Material | null {
        if (this._tintMat && this._tintMat.isValid) return this._tintMat;
        const tpl = this.heatPlane;
        if (!tpl || !tpl.isValid) return null;
        const mr = tpl.getComponent(MeshRenderer);
        // 用 sharedMaterial：所有克隆平面共用同一个材质资产，改一次全变
        this._tintMat = (mr && mr.sharedMaterial) ? mr.sharedMaterial : null;
        return this._tintMat;
    }

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

    /**
     * 诊断 FSR 链路（custom pipeline 探针）：一次性把"降分辨率 + FSR 到底走哪条链路"的关键状态
     * 全打出来。用来回答：thermal 写的 pipeline.shadingScale，和 custom pipeline 的 PostProcess/FSR
     * 组件之间有没有联动、FSR 会不会真的升采样。
     * 用法：编辑器预览里执行 `stressTest.diagFsr()` 。
     */
    public diagFsr() {
        const out: any = {};

        // ① 当前管线类型
        const root: any = (director as any).root;
        const pipeline: any = root ? root.pipeline : null;
        out.pipelineClass = pipeline ? (pipeline.constructor ? pipeline.constructor.name : 'unknown') : 'null';
        out.pipelineShadingScale = pipeline ? Number((pipeline.shadingScale || 1).toFixed(3)) : 'n/a';

        // ② 3D 相机及其 usePostProcess 状态
        const cam = this._findCamera();
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
        this.generateObjects(this.spawnCount);
        if (!fromSlider && this.countSlider) {
            this.countSlider.setValue(this.spawnCount, true);
        }
    }

    /** 场景 B 的加压旋钮：每个立方体每帧额外做多少次浮点运算（0 = 关） */
    public setCpuWork(n: number) {
        this.cpuWorkPerCube = Math.max(0, Math.floor(n));
        console.log('[StressTest] cpuWorkPerCube = ' + this.cpuWorkPerCube
            + '（约 ' + (this.currentObjects.length * this.cpuWorkPerCube) + ' 次浮点运算/帧）');
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
        const root: any = (director as any).root;
        const pipeline = root?.pipeline;
        if (pipeline) {
            pipeline.shadingScale = scale;
        }
        cclegacy.rendering?.forceResizeAllWindows?.();
        console.log('[StressTest] shadingScale = ' + scale.toFixed(2)
            + ' (readback ' + (pipeline ? pipeline.shadingScale.toFixed(2) : 'N/A')
            + '), FSR=' + (this._fsrReady ? 'READY' : 'PENDING'));
        this._updateDrsLabel();
    }

    /** 打一行当前状态（真机控制台里最常用的自查手段） */
    public logStatus() {
        const s: any = this.getStatus();
        console.log('[StressTest] status: ' + JSON.stringify(s));
        return s;
    }

    // ==================== DRS 自动切换（A/B 验证用） ====================

    /**
     * 启动"每 N 秒切一次 DRS"的循环：先跑 10 秒满分辨率做基线，再切到低分辨率 10 秒，如此循环。
     * 每次切换都会打印**上一窗口**的实测 fps，所以控制台里能直接读出两档的差值；
     * CSV 的 shading_scale 列也会变成 1.00 / 0.30 的方波，事后画图就能对齐。
     *
     * 关于 FSR：4.0 里 FSR 是 post-process（PostProcess/FSR），而 thermal 的 FSR 钩子写的是
     * camera.pipelineSettings.fsr —— 这个字段在当前引擎里没有读取方，调 setFsrEnabled 只会每 10 秒
     * 刷一条 "BuiltinPipelineSettings is unavailable" 警告。所以这里只切 shadingScale，
     * 测出来的是**纯降分辨率**的收益（这也是影响帧率的主体）。
     */
    public startDrsToggle(): void {
        this.stopDrsToggle();
        this._drsOn = false;
        this._drsScale = 1.0;
        this._applyDrs(false);                       // 从"不降"开始，先拿基线
        this._drsTick = () => this._applyDrs(!this._drsOn);
        this.schedule(this._drsTick, Math.max(1, this.drsToggleInterval));
        console.log('[StressTest] DRS 循环启动：shadingScale 在 1.00 和 ' + this.drsLowScale.toFixed(2)
            + ' 之间切换，每 ' + this.drsToggleInterval + 's 一次（stopDrsToggle() 停止）');
        if (!this.drsLabel) {
            console.log('[StressTest] 想看屏幕上的档位数字就把一个 Label 拖到 Drs Label 槽');
        }
        console.log('[StressTest] 注：FSR 不参与切换（4.0 的 FSR 是 post-process，thermal 的钩子在当前引擎是空转），'
            + '所以这是纯 shadingScale 的 A/B');
        if (this.enableThermalControl) {
            console.warn('[StressTest] 温控也会写 shadingScale，会和这个循环抢；做 A/B 时请把 enableThermalControl 关掉');
        }
    }

    /** 停止 DRS 循环，并把分辨率还原到 1.0 */
    public stopDrsToggle(): void {
        if (!this._drsTick) return;
        this.unschedule(this._drsTick);
        this._drsTick = null;
        if (this._drsScale < 1) {
            this.setScale(1.0);
            this._drsScale = 1.0;
            this._updateDrsLabel();
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
    private _applyDrs(on: boolean): void {
        this._drsOn = on;
        const from = this._drsScale;
        const to = on ? this.drsLowScale : 1.0;
        this._drsScale = to;

        this.setScale(to);

        const fps = this.csv.lastFps;
        const ft = fps > 0 ? (1000 / fps) : 0;
        console.log('[StressTest] DRS ' + from.toFixed(2) + ' → ' + to.toFixed(2)
            + (fps > 0 ? ' | 上一档实测 ' + fps.toFixed(1) + 'fps (ft=' + ft.toFixed(2) + 'ms)' : ' | 测基线中…'));
        this._updateDrsLabel();
    }

    /** 屏幕上的档位显示：直接读 pipeline 的实际 shadingScale + 最近窗口 fps，所以温控改档时也是真的 */
    private _updateDrsLabel(): void {
        if (!this.drsLabel) return;
        const pipeline = (director as any).root?.pipeline;
        const scale = pipeline ? Number(pipeline.shadingScale) : this._drsScale;
        const fps = this.csv.lastFps;
        this.drsLabel.string = 'shadingScale ' + scale.toFixed(2)
            + (fps > 0 ? '   ' + fps.toFixed(1) + ' fps' : '');
    }

    // ==================== FSR (builtin pipeline) ====================

    /**
     * 一期纯降分辨率，不启用 FSR。此方法仅加载材质占位，二期启用 FSR 时再挂接。
     */
    private _initFsr(done: () => void) {
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

    // ==================== 温控（引擎 thermal 模块）====================

    private static readonly THERMAL_LEVEL_NAMES = ['Normal', 'Hot', 'Emergency'];

    /**
     * 开启温控。杠杆顺序（引擎行为）：
     *   降档：先 shadingScale（场景 A 要验证的杠杆），scale 到地板后才降帧率；
     *   自动试探升档（enableAutoUpgrade=true）：先分辨率，scale 升满后再升帧率；
     *   手动 stepUp()：先帧率，再分辨率。
     * 触发条件：20s 滑动窗口的平均帧时间 ≥ 预算 × (1 + triggerPercent%)；
     * 另外前 thermalWarmupSeconds 秒是预热期，不会动作也不计入 CSV。
     */
    public thermalOn() {
        const cfg: any = {
            minFrameRate: this.thermalMinFrameRate,
            triggerPercent: this.thermalTriggerPercent,
            minScale: this.thermalMinScale,
            warmupSeconds: this.thermalWarmupSeconds,
            enableAutoUpgrade: this.enableAutoUpgrade,
            probeIntervalSeconds: this.probeIntervalSeconds,
            recoveryProbeSeconds: this.recoveryProbeSeconds,
            enableScale: true,
            enableFsr: false,
        };
        thermal.enable(cfg);
        thermal.onLevelChange((level) => {
            console.log('[StressTest] thermal level changed -> ' + StressTestController.THERMAL_LEVEL_NAMES[level]);
        });
        if (typeof (thermal as any).onAction === 'function') {
            (thermal as any).onAction((e: any) => {
                this._log('thermal ' + e.direction + ' ' + e.lever + ' ' + e.from + ' -> ' + e.to
                    + ' level=' + e.level
                    + (e.avgMs && e.targetMs ? (' avg=' + e.avgMs.toFixed(2) + 'ms target=' + e.targetMs.toFixed(2) + 'ms') : ''));
            });
        }
        const state = thermal.getState();
        console.log('[StressTest] thermal ON: level=' + state.level
            + ', scale=' + Number(state.shadingScale).toFixed(2)
            + ', fps=' + state.frameRate
            + ', trigger=' + this.thermalTriggerPercent + '%'
            + ', FSR=' + (this._fsrReady ? 'READY' : 'PENDING'));
    }

    /** 关闭温控，帧率/分辨率还原 */
    public thermalOff() {
        thermal.disable();
        console.log('[StressTest] thermal OFF; frame rate and scale restored');
    }

    /** 手动降一档（走 ScaleAction 优先） */
    public thermalDown(): boolean {
        const ok = thermal.stepDown();
        console.log('[StressTest] manual thermal down: ' + (ok ? 'ok' : 'floor')
            + '; level=' + StressTestController.THERMAL_LEVEL_NAMES[thermal.getLevel()]);
        return ok;
    }

    /** 手动升一档 */
    public thermalUp(): boolean {
        const ok = thermal.stepUp();
        console.log('[StressTest] manual thermal up: ' + (ok ? 'ok' : 'top')
            + '; level=' + StressTestController.THERMAL_LEVEL_NAMES[thermal.getLevel()]);
        return ok;
    }

    /** 读当前温控档位 */
    public thermalLevel(): number {
        const level = thermal.getLevel();
        console.log('[StressTest] thermal level: ' + StressTestController.THERMAL_LEVEL_NAMES[level] + ' (' + level + ')');
        return level;
    }

    /** 运行时改降档阈值（%），真机上调"多容易触发降档"，不用重新构建 */
    public setTriggerPercent(percent: number) {
        this.thermalTriggerPercent = percent;
        (thermal as any).setThreshold?.(percent);
        console.log('[StressTest] thermal triggerPercent = ' + percent + '%');
    }

    // ==================== UI 回调 ====================

    /** 实例颜色开关（场景 B 用：每 colorSwitchInterval 帧给所有立方体换一次色） */
    public onColorToggleChanged(toggle: Toggle) {
        if (!toggle) return;
        this.enableDynamicColor = toggle.isChecked;
        console.log('[StressTest] dynamic color = ' + this.enableDynamicColor
            + (this.currentObjects.length === 0 ? '（当前没有立方体，无实际开销）' : '（' + this.currentObjects.length + ' 个立方体，开启后每帧线性增加 CPU）'));
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
            mode: this.currentObjects.length > 0 ? 'B/CPU' : 'A/GPU',
            heatPlanes: this.planes.count,
            planeCoverage: Number(this.planeCoverage.toFixed(2)),
            gpuLayers: this.planes.count,
            cubes: this.currentObjects.length,
            cpuWorkPerCube: this.cpuWorkPerCube,
            particleRate: this.particleRate,
            fps: Number(this.csv.lastFps.toFixed(1)),
            frameRate: game.frameRate,
            shadingScale: pipeline ? Number(pipeline.shadingScale.toFixed(2)) : 'N/A',
            thermalLevel: state.level,
            thermalScale: Number(state.shadingScale),
            sampling: this.csv.sampling,
            csvRows: this.csv.rowCount,
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

    // ==================== 场景 B：立方体（CPU 负载） ====================

    /**
     * 生成 N 个立方体。只在滑块变化/启动时调用，不在 update() 里。
     * 每个立方体在生成时写一次实例颜色（a_instanced_color），之后由 _animateCubes 决定是否继续改。
     */
    private generateObjects(count: number) {
        this.clearObjects();
        const prefab = this.testObjectPrefab;
        if (!prefab) {
            if (count > 0) console.warn('[StressTest] testObjectPrefab is missing; skip object generation');
            return;
        }
        for (let i = 0; i < count; i++) {
            const obj = instantiate(prefab);
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.random() * this.spawnRadius;
            obj.setPosition(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);

            // 必须先加入场景，实例化属性才生效
            this.node.addChild(obj);

            const model = obj.getComponent(MeshRenderer);
            if (model) {
                model.setInstancedAttribute('a_instanced_color', [
                    Math.floor(Math.random() * 256),
                    Math.floor(Math.random() * 256),
                    Math.floor(Math.random() * 256),
                    255
                ]);
            }

            this.currentObjects.push(obj);
        }
        if (count > 0) {
            console.log('[StressTest] object count = ' + count);
            console.warn('[StressTest] 已启用 CPU 负载（' + count + ' 个立方体，每帧 O(N) 遍历'
                + (this.cpuWorkPerCube > 0 ? ' + ' + (count * this.cpuWorkPerCube) + ' 次浮点运算' : '')
                + '）。这组数据反映 CPU 瓶颈，不要用来评估 GPU / 降分辨率收益。');
        }
    }

    /** 销毁所有立方体（下一次 generateObjects 会重建） */
    private clearObjects() {
        this.currentObjects.forEach(obj => {
            if (obj && obj.isValid) obj.destroy();
        });
        this.currentObjects = [];
    }
}
