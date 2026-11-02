import {
    _decorator, Component, Node, Prefab, instantiate, profiler,
    Toggle, Vec3, MeshRenderer, director, screen, game, thermal, cclegacy,
    Material, resources,
} from 'cc';
import { SliderBinder } from './SliderBinder';
const { ccclass, property } = _decorator;

// load_gpu_layers: 实际写入 HeatLayer 节点数（历史列名，保持 CSV 兼容）
const CSV_HEADER = 'elapsed_s,ts_ms,fps,ft_avg_ms,ft_p95_ms,ft_max_ms,jank_gt_2x,battery_pct,load_gpu_layers,spawn_count,shading_scale,frame_rate';

@ccclass('StressTestController')
export class StressTestController extends Component {

    // ============ 基础配置 ============

    @property(Prefab)
    public testObjectPrefab: Prefab | null = null;

    @property({ tooltip: '生成半径' })
    public spawnRadius: number = 20;

    @property({ tooltip: '是否把 CSV 结果写入手机文件' })
    public writeCsv: boolean = true;

    @property({ tooltip: '是否开启温控（代码开关）：勾选=开温控，不勾=关温控' })
    public enableThermalControl: boolean = false;

    @property({ tooltip: '初始生成数量' })
    public spawnCount: number = 500;

    // ============ 动画参数（CPU 侧）============

    @property({ tooltip: '自转速度（度/秒）' })
    public rotationSpeed: number = 90;

    @property({ tooltip: '上下浮动幅度' })
    public floatAmplitude: number = 2;

    @property({ tooltip: '浮动频率' })
    public floatFrequency: number = 1;

    @property({ tooltip: '绕中心公转速度（度/秒）' })
    public orbitSpeed: number = 10;

    // ============ GPU Instancing 颜色变换 ============

    @property({ tooltip: '是否随机切换实例颜色（GPU 侧，CPU 几乎零成本）' })
    public enableDynamicColor: boolean = false;

    @property({ tooltip: '颜色切换间隔（帧），越大 CPU 越轻松，0 表示每帧切换' })
    public colorSwitchInterval: number = 10;

    // ============ UI 引用 ============

    @property(SliderBinder)
    public countSlider: SliderBinder | null = null;

    @property(Toggle)
    public colorToggle: Toggle | null = null;

    @property({ type: Node, tooltip: '发热层模板节点（场景里的 HeatLayer，留空则按名字自动查找）' })
    public heatLayerTemplate: Node | null = null;

    // ============ 内部状态 ============

    private currentObjects: Node[] = [];
    private _frameCounter: number = 0;

    private _heatLayers: Node[] = [];
    private _heatLayerCount: number = 0;
    private _sampling: boolean = false;
    private _lastFrameNow: number = 0;
    private _windowStart: number = 0;
    private _windowFrames: number[] = [];
    private _csvRows: string[] = [];
    private _startTimestamp: number = 0;
    private _fsrReady: boolean = false;

    // ============ 生命周期 ============

    onLoad() {
        if (this.countSlider) {
            this.countSlider.setValue(this.spawnCount, true);
            this.countSlider.onChange((v) => this.setSpawnCount(v, true));
        }
    }

    start() {
        profiler.showStats();
        this.generateObjects(this.spawnCount);
        this.refreshUI();

        this.initFsr();

        if (this.enableThermalControl) {
            this.thermalOn();
        }

        this.startLogging();
        if (this.writeCsv) {
            this.cleanOldCsv();
            this.schedule(() => this._autoExport(), 60);
        }

        const heatTemplate = this._findHeatLayerTemplate();
        if (heatTemplate && heatTemplate.active) {
            this._heatLayerCount = 1;
        }

        (globalThis as any).stressTest = this;
        console.log('[StressTest] attached to globalThis.stressTest');
        console.log('  load: setSpawnCount(n) | setScale(s) | setHeatLayerCount(n)');
        console.log('  run : setFps(n) | getFps() | getStatus() | exportCsv()');
        console.log('  thermal: thermalOn() | thermalOff() | thermalDown() | thermalUp() | thermalLevel()');
    }

    // ============ update：CPU 优化版 ============

    update(dt: number) {
        if (this._sampling) {
            const now = performance.now();
            if (this._lastFrameNow > 0) {
                this._windowFrames.push(now - this._lastFrameNow);
            }
            this._lastFrameNow = now;
            if (now - this._windowStart >= 5000) {   // 每 5 秒一行，跟 adb 温度采样对齐
                this._flushCsvRow(now);
                this._windowStart = now;
                this._windowFrames.length = 0;
            }
        }
        const objects = this.currentObjects;
        const len = objects.length;
        if (len === 0) return;

        const t = director.getTotalTime();
        const rotSpeed = this.rotationSpeed * dt;
        const orbitRad = this.orbitSpeed * Math.PI / 180 * dt;
        const rotSpeedY = rotSpeed * 0.7;
        const rotSpeedZ = rotSpeed * 0.3;
        const floatAmp = this.floatAmplitude;
        const floatFreq = this.floatFrequency;

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

            // 浮动 + 公转
            const pos = obj.position;
            const y = Math.sin(t * floatFreq + i) * floatAmp;
            const radius = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
            const angle = Math.atan2(pos.z, pos.x) + orbitRad;
            obj.setPosition(Math.cos(angle) * radius, y, Math.sin(angle) * radius);

            // 实例化颜色变换（GPU 侧）
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
        }
    }

    // ============ 对外接口 ============

    public setSpawnCount(count: number, fromSlider: boolean = false) {
        this.spawnCount = Math.max(0, Math.floor(count));
        this.generateObjects(this.spawnCount);
        if (!fromSlider && this.countSlider) {
            this.countSlider.setValue(this.spawnCount, true);
        }
    }

    /** 运行时开关颜色变换 */
    public setColorEnabled(enabled: boolean) {
        this.enableDynamicColor = enabled;
        if (this.colorToggle) {
            this.colorToggle.isChecked = enabled;
        }
        console.log('[StressTest] dynamic color = ' + (enabled ? 'ON' : 'OFF'));
    }

    public setFps(fps: number) {
        game.frameRate = fps;
        console.log('[StressTest] frameRate = ' + fps + ' (readback ' + game.frameRate + ')');
    }

    public getFps(): string | number {
        return game.frameRate;
    }

    /** 直接设渲染分辨率缩放（shadingScale），验证降/升分辨率是否生效 */
    public setScale(scale: number) {
        const root: any = (director as any).root;
        const pipeline = root?.pipeline;
        if (pipeline) {
            pipeline.shadingScale = scale;
        }
        cclegacy.rendering?.forceResizeAllWindows?.();
        console.log('[StressTest] shadingScale = ' + scale.toFixed(2) + ' (readback ' + (pipeline ? pipeline.shadingScale.toFixed(2) : 'N/A') + '), FSR=' + (this._fsrReady ? 'READY' : 'PENDING'));
    }

    // ============ FSR (builtin pipeline) ============

    private initFsr() {
        if (typeof (thermal as any).setFsrMaterial !== 'function') {
            console.warn('[StressTest] thermal.setFsrMaterial is unavailable; rebuild the custom engine to enable FSR.');
            return;
        }
        resources.load('fsr/builtin-fsr', Material, (err, material) => {
            if (err || !material) {
                console.error('[StressTest] FSR material load failed', err);
                return;
            }
            (thermal as any).setFsrMaterial(material);
            this._fsrReady = true;
            console.log('[StressTest] FSR material ready: ' + material.name);
        });
    }

    // ============ 温控（引擎 thermal 模块）============

    private static readonly THERMAL_LEVEL_NAMES = ['Normal', 'Warm', 'Hot', 'Critical', 'Emergency'];

    /** 开启温控（自动模式：采样→策略→先降分辨率，再降帧率） */
    public thermalOn() {
        thermal.enable({ minFrameRate: 30, triggerPercent: 10 });
        thermal.onLevelChange((level) => {
            console.log('[StressTest] thermal level changed -> ' + StressTestController.THERMAL_LEVEL_NAMES[level]);
        });
        const state = thermal.getState();
        console.log('[StressTest] thermal ON: level=' + state.level
            + ', scale=' + Number(state.shadingScale).toFixed(2)
            + ', fps=' + state.frameRate
            + ', FSR=' + (this._fsrReady ? 'READY' : 'PENDING'));
    }

    /** 关闭温控，帧率/分辨率还原 */
    public thermalOff() {
        thermal.disable();
        console.log('[StressTest] thermal OFF; frame rate and scale restored');
    }

    /** 手动降一档（走 FrameRateAction + ScaleAction） */
    public thermalDown(): boolean {
        const ok = thermal.stepDown();
        console.log('[StressTest] manual thermal down: ' + (ok ? 'ok' : 'floor') + '; level=' + StressTestController.THERMAL_LEVEL_NAMES[thermal.getLevel()]);
        return ok;
    }

    /** 手动升一档（走 FrameRateAction + ScaleAction） */
    public thermalUp(): boolean {
        const ok = thermal.stepUp();
        console.log('[StressTest] manual thermal up: ' + (ok ? 'ok' : 'top') + '; level=' + StressTestController.THERMAL_LEVEL_NAMES[thermal.getLevel()]);
        return ok;
    }

    /** 读当前温控档位 */
    public thermalLevel(): number {
        const level = thermal.getLevel();
        console.log('[StressTest] thermal level: ' + StressTestController.THERMAL_LEVEL_NAMES[level] + ' (' + level + ')');
        return level;
    }

    // ============ UI 回调 ============

    public onColorToggleChanged(toggle: Toggle) {
        this.enableDynamicColor = toggle.isChecked;
        console.log('[StressTest] dynamic color = ' + this.enableDynamicColor);
    }

    public refreshUI() {
        if (this.colorToggle) {
            this.colorToggle.isChecked = this.enableDynamicColor;
        }
    }

    public getStatus() {
        const pipeline = (director as any).root?.pipeline;
        return {
            spawnCount: this.spawnCount,
            actualCount: this.currentObjects.length,
            enableDynamicColor: this.enableDynamicColor,
            colorSwitchInterval: this.colorSwitchInterval,
            shadingScale: pipeline ? pipeline.shadingScale : 'N/A',
            gameFrameRate: game.frameRate,
            devicePixelRatio: screen.devicePixelRatio,
            heatLayers: this._heatLayerCount,
            sampling: this._sampling,
            csvRows: this._csvRows.length
        };
    }

    // ============ 帧时间自采（CSV 可选落盘）============

    public startLogging() {
        this._sampling = true;
        this._startTimestamp = performance.now();
        this._windowStart = this._startTimestamp;
        this._lastFrameNow = 0;
        this._windowFrames.length = 0;
        this._csvRows.length = 0;
        this._csvRows.push(CSV_HEADER);
        console.log('[StressTest] frame-time sampling started (1 row / 5s, writeCsv=' + this.writeCsv + ')');
    }

    public stopLogging() {
        this._sampling = false;
        console.log('[StressTest] sampling stopped; rows=' + (this._csvRows.length - 1));
    }

    public exportCsv() {
        if (!this.writeCsv) {
            console.warn('[StressTest] writeCsv is off; skip file export');
            return;
        }
        if (this._csvRows.length <= 1) {
            console.warn('[StressTest] no CSV data');
            return;
        }
        const csv = this._csvRows.join('\n');
        const wx = this._getWx();
        if (wx && wx.getFileSystemManager) {
            const fs = wx.getFileSystemManager();
            const filePath = wx.env.USER_DATA_PATH + '/thermal_' + Date.now() + '.csv';
            fs.writeFile({
                filePath: filePath,
                data: csv,
                encoding: 'utf8',
                success: () => {
                    console.log('[StressTest] CSV exported: ' + filePath + ' (' + (this._csvRows.length - 1) + ' rows)');
                },
                fail: (err: any) => {
                    console.error('[StressTest] CSV write failed', err);
                }
            });
        } else {
            console.log('[StressTest] CSV sampling (non-WeChat): ' + (this._csvRows.length - 1) + ' rows');
        }
    }

    private _flushCsvRow(now: number) {
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
        const sorted = frames.slice().sort((a, b) => a - b);
        const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
        const budget2x = (1000 / (Number(game.frameRate) || 60)) * 2;
        let jank = 0;
        for (let i = 0; i < n; i++) {
            if (frames[i] > budget2x) jank++;
        }
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
            this._heatLayerCount,
            this.currentObjects.length,
            shadingScale,
            String(game.frameRate)
        ].join(',');
        this._csvRows.push(row);
    }

    private _toast(msg: string) {
        const wx = this._getWx();
        if (wx && typeof wx.showToast === 'function') {
            wx.showToast({ title: msg, icon: 'none', duration: 2500 });
        }
        console.log('[StressTest] ' + msg);
    }

    private _log(msg: string) {
        console.log('[StressTest] ' + msg);
        const wx = this._getWx();
        if (wx && typeof wx.getRealtimeLogManager === 'function') {
            try {
                wx.getRealtimeLogManager().info(msg);
            } catch (e) {
                // ignore
            }
        }
    }

    public cleanOldCsv(): void {
        if (!this.writeCsv) {
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
                    this._log('cleanOldCsv: no old thermal files');
                    return;
                }
                let pending = names.length;
                let removed = 0;
                const done = () => {
                    pending -= 1;
                    if (pending > 0) return;
                    this._log('cleanOldCsv: removed ' + removed + '/' + names.length);
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
                            this._log('cleanOldCsv unlink failed: ' + name + ' ' + JSON.stringify(err));
                            done();
                        }
                    });
                });
            },
            fail: (err: any) => {
                console.error('[StressTest] cleanOldCsv readdir failed', err);
                this._log('cleanOldCsv readdir failed: ' + JSON.stringify(err));
            }
        });
    }

    private _autoExport() {
        if (!this.writeCsv) return;
        if (this._csvRows.length <= 1) return;
        const wx = this._getWx();
        if (wx && wx.getFileSystemManager) {
            this.exportCsv();
        } else {
            console.log('[StressTest] CSV sampling (non-WeChat): ' + (this._csvRows.length - 1) + ' rows');
        }
    }

    private _getWx(): any {
        const g: any = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
        return g.wx;
    }

    private _getBatteryPct(): string {
        try {
            const wx = this._getWx();
            if (wx && wx.getBatteryInfoSync) {
                const info = wx.getBatteryInfoSync();
                if (info && typeof info.level === 'number') return String(info.level);
            }
        } catch (e) { }
        return 'NA';
    }

    // ============ 发热层控制 ============

    public setHeatLayerCount(count: number) {
        count = Math.max(0, Math.floor(count));
        const template = this._findHeatLayerTemplate();
        if (template) {
            template.active = count > 0;
        }
        const targetClones = template ? Math.max(0, count - 1) : Math.max(0, count);
        while (this._heatLayers.length < targetClones) {
            const clone = this._cloneHeatLayer(template);
            if (clone) this._heatLayers.push(clone);
            else break;
        }
        while (this._heatLayers.length > targetClones) {
            const layer = this._heatLayers.pop();
            if (layer && layer.isValid) layer.destroy();
        }
        this._heatLayerCount = count;
        console.log('[StressTest] heat layers = ' + count);
    }

    private _findHeatLayerTemplate(): Node | null {
        if (this.heatLayerTemplate && this.heatLayerTemplate.isValid) return this.heatLayerTemplate;
        return this._findByName(this.node.scene, 'HeatLayer');
    }

    private _findByName(root: Node | null, name: string): Node | null {
        if (!root) return null;
        if (root.name === name) return root;
        for (const child of root.children) {
            const found = this._findByName(child, name);
            if (found) return found;
        }
        return null;
    }

    private _cloneHeatLayer(template: Node | null): Node | null {
        if (!template) {
            console.warn('[StressTest] HeatLayer template not found');
            return null;
        }
        const clone = instantiate(template);
        clone.name = 'HeatLayer_' + (this._heatLayers.length + 2);
        clone.setParent(template.parent);
        clone.layer = template.layer;
        return clone;
    }

    private generateObjects(count: number) {
        this.clearObjects();
        if (!this.testObjectPrefab) {
            console.warn('[StressTest] testObjectPrefab is missing; skip object generation');
            return;
        }
        for (let i = 0; i < count; i++) {
            const obj = instantiate(this.testObjectPrefab);
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
        console.log('[StressTest] object count = ' + count);
    }

    private clearObjects() {
        this.currentObjects.forEach(obj => {
            if (obj && obj.isValid) obj.destroy();
        });
        this.currentObjects = [];
    }
}
