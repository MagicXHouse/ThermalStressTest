import { Node, MeshRenderer, Prefab, instantiate } from 'cc';

/**
 * 场景 B 的 CPU 负载：立方体的生成 / 销毁 / 逐帧动画。
 * 从 StressTestController 里拆出来的，行为与拆分前逐字一致。
 *
 * 关键约束：count === 0 时 animate() 立刻返回 —— 保证场景 A（纯 GPU）每帧不遍历任何节点，
 * 这是红线 2 的运行时边界。
 */
export class CpuCubes {
    private _ctrl: any;
    /** 场景 B 的立方体节点 */
    private _nodes: Node[] = [];
    /**
     * 生成时写一次实例颜色的复用缓冲。
     * 注意：**这一步不能删** —— Cube 的材质用 `mainColor * a_instanced_color`，
     * 不写这个属性立方体会是黑的。每帧换色那套逻辑已经删掉了，这里只做初始化。
     */
    private readonly _colorScratch = new Float32Array(4);
    /** 吸收 cpuWorkPerCube 的计算结果，防止 JIT 把循环优化掉 */
    private _cpuSink = 0;
    /** 上一帧 animate() 的 CPU 耗时（毫秒）——用来回答"这到底是不是在压 CPU" */
    private _msLast = 0;
    /** CPU 耗时的指数滑动平均（alpha=0.1） */
    private _msAvg = 0;

    constructor (ctrl: any) {
        this._ctrl = ctrl;
    }

    /** 上一帧 animate() 的 CPU 耗时（毫秒） */
    public get lastMs (): number { return this._msLast; }

    /** animate() CPU 耗时的滑动平均（毫秒） */
    public get avgMs (): number { return this._msAvg; }

    /** 单立方体平均耗时（微秒），用来判断成本是否随 N 线性 */
    public get perCubeUs (): number {
        const n = this._nodes.length;
        return n > 0 ? (this._msAvg * 1000) / n : 0;
    }

    /** 当前立方体数量（getStatus / 日志 / CSV 的 spawn_count 读它） */
    public get count (): number { return this._nodes.length; }

    /**
     * 生成 N 个立方体。只在滑块变化/启动时调用，不在 update() 里。
     * 每个立方体在生成时写一次实例颜色（a_instanced_color），之后不再改。
     */
    public generate (count: number): void {
        this.clear();
        const prefab: Prefab | null = this._ctrl.testObjectPrefab;
        if (!prefab) {
            if (count > 0) console.warn('[StressTest] testObjectPrefab is missing; skip object generation');
            return;
        }
        for (let i = 0; i < count; i++) {
            const obj = instantiate(prefab);
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.random() * this._ctrl.spawnRadius;
            obj.setPosition(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);

            // 必须先加入场景，实例化属性才生效
            this._ctrl.node.addChild(obj);

            const model = obj.getComponent(MeshRenderer);
            if (model) {
                const c = this._colorScratch;
                c[0] = Math.floor(Math.random() * 256);
                c[1] = Math.floor(Math.random() * 256);
                c[2] = Math.floor(Math.random() * 256);
                c[3] = 255;
                model.setInstancedAttribute('a_instanced_color', c);
            }

            this._nodes.push(obj);
        }
        if (count > 0) {
            const perCube = Math.floor(this._ctrl.perCubeBaseOps + this._ctrl.cpuWorkPerCube);
            const planes = this._ctrl.planes ? this._ctrl.planes.count : 0;
            console.log('[StressTest] object count = ' + count);
            // 混合负载是合法配置（GPU 层数 + CPU 立方体可同时开），这里只报告当前构成，不做"该/不该"的暗示
            console.log('[StressTest] CPU 负载：' + count + ' 个立方体 × 每帧 ' + perCube
                + ' 次浮点运算 ≈ ' + (count * perCube) + ' 次/帧'
                + '；当前负载 = GPU ' + planes + ' 层 + CPU ' + count + ' 个'
                + (planes > 0 ? '（混合负载）' : '（纯 CPU）'));
        }
    }

    /** 销毁所有立方体（下一次 generate 会重建） */
    public clear (): void {
        this._nodes.forEach(obj => {
            if (obj && obj.isValid) obj.destroy();
        });
        this._nodes = [];
    }

    /**
     * 场景 B 的 CPU 负载主体：每帧遍历所有立方体，改 transform + 每个立方体做固定量的浮点运算。
     *
     * 为什么要有"每立方体基础运算"：只写 transform 的话，2000 个立方体也才 ~1ms，
     * 根本压不过 16.67ms 的帧预算（实测 ft_avg 反而更低）。所以每个立方体再加
     * `perCubeBaseOps` 次浮点运算，让**数量本身**就是负载旋钮：
     *     每帧运算量 ≈ count × (perCubeBaseOps + cpuWorkPerCube)
     * 关系是严格线性的，可以用 getStatus().cubeCpuMs 校准。
     */
    public animate (dt: number): void {
        const objects = this._nodes;
        const len = objects.length;
        if (len === 0) {
            // 场景 A：一行循环都不进（红线 2），顺便把计时归零
            this._msLast = 0;
            this._msAvg = 0;
            return;
        }

        const t0 = performance.now();

        const rotSpeed = this._ctrl.rotationSpeed * dt;
        const orbitRad = this._ctrl.orbitSpeed * Math.PI / 180 * dt;
        const rotSpeedY = rotSpeed * 0.7;
        const rotSpeedZ = rotSpeed * 0.3;
        const work = Math.max(0, Math.floor(this._ctrl.perCubeBaseOps + this._ctrl.cpuWorkPerCube));

        for (let i = 0; i < len; i++) {
            const obj = objects[i];
            if (!obj || !obj.isValid) continue;

            // 自转：直接 setRotationFromEuler(x, y, z)，不再每帧 new Vec3（否则每秒几十万次分配，GC 抖动）
            const euler = obj.eulerAngles;
            obj.setRotationFromEuler(euler.x + rotSpeed, euler.y + rotSpeedY, euler.z + rotSpeedZ);

            // 公转（已去掉上下浮动：抖动刺眼，floatAmplitude/floatFrequency 两个属性已删除，Y 保持不变）
            const pos = obj.position;
            const radius = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
            const angle = Math.atan2(pos.z, pos.x) + orbitRad;
            obj.setPosition(Math.cos(angle) * radius, pos.y, Math.sin(angle) * radius);

            // 可选：纯浮点负载，用来在立方体数量不变时继续加压（结果写进字段，防止被优化掉）
            if (work > 0) {
                let acc = this._cpuSink + i;
                for (let k = 0; k < work; k++) {
                    acc = acc * 1.0000001 + 0.5;
                }
                this._cpuSink = acc % 1000;
            }
        }

        // 计时只包住这个循环：得到的是"立方体脚本自己"的 CPU 成本，不含渲染/引擎其他部分。
        // 拿去和 16.67ms 的帧预算比，就知道它到底有没有在压 CPU。
        this._msLast = performance.now() - t0;
        this._msAvg = this._msAvg * 0.9 + this._msLast * 0.1;
    }
}
