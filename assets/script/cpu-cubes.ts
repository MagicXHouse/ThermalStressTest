import { Node, Vec3, MeshRenderer, Prefab, instantiate } from 'cc';

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
    /** 颜色切换节流计数（帧） */
    private _frameCounter = 0;
    /** 吸收 cpuWorkPerCube 的计算结果，防止 JIT 把循环优化掉 */
    private _cpuSink = 0;

    constructor (ctrl: any) {
        this._ctrl = ctrl;
    }

    /** 当前立方体数量（getStatus / 日志 / CSV 的 spawn_count 读它） */
    public get count (): number { return this._nodes.length; }

    /**
     * 生成 N 个立方体。只在滑块变化/启动时调用，不在 update() 里。
     * 每个立方体在生成时写一次实例颜色（a_instanced_color），之后由 animate() 决定是否继续改。
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
                model.setInstancedAttribute('a_instanced_color', [
                    Math.floor(Math.random() * 256),
                    Math.floor(Math.random() * 256),
                    Math.floor(Math.random() * 256),
                    255
                ]);
            }

            this._nodes.push(obj);
        }
        if (count > 0) {
            console.log('[StressTest] object count = ' + count);
            console.warn('[StressTest] 已启用 CPU 负载（' + count + ' 个立方体，每帧 O(N) 遍历'
                + (this._ctrl.cpuWorkPerCube > 0 ? ' + ' + (count * this._ctrl.cpuWorkPerCube) + ' 次浮点运算' : '')
                + '）。这组数据反映 CPU 瓶颈，不要用来评估 GPU / 降分辨率收益。');
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
     * 场景 B 的 CPU 负载主体：每帧遍历所有立方体，改 transform（+可选改实例颜色）。
     * 这就是"CPU 瓶颈"的来源：N 个立方体 = N 次 euler/position 写入 + N 次引擎侧世界矩阵更新。
     */
    public animate (dt: number): void {
        const objects = this._nodes;
        const len = objects.length;
        if (len === 0) return;     // 场景 A：一行循环都不进（红线 2）

        const rotSpeed = this._ctrl.rotationSpeed * dt;
        const orbitRad = this._ctrl.orbitSpeed * Math.PI / 180 * dt;
        const rotSpeedY = rotSpeed * 0.7;
        const rotSpeedZ = rotSpeed * 0.3;
        const work = Math.max(0, Math.floor(this._ctrl.cpuWorkPerCube));

        this._frameCounter++;
        const doColorSwitch = this._ctrl.enableDynamicColor
            && (this._ctrl.colorSwitchInterval <= 0 || this._frameCounter % this._ctrl.colorSwitchInterval === 0);

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
}
