import { Node, Label, UITransform, Graphics, Color, Layers, Canvas, director } from 'cc';

/**
 * 开发者面板（运行时创建，不改场景）：
 *
 *   [分辨率温控: 开]      ← 点一下切换
 *   [帧率温控: 开]
 *   [分辨率档位: 0.85/0.70]  ← 点一下在预设梯度间循环
 *   [帧率档位: 60/30]
 *   状态: −
 *
 * 给**开发者**用，不是给测试同事：测试同事只点「复制CSV」，实验条件由本面板与记录卡固定。
 *
 * 为什么档位用预设循环而不是输入框：微信小游戏里 EditBox 要拉系统键盘，位置/遮挡在
 * 不同机型上很脆；预设梯度能覆盖实验需要（温和 / 标准 / 激进），且不会敲错。
 * 需要任意梯度时用命令 `tiers:0.9,0.8,0.7`。
 */
export class DevDashboard {
    private _ctrl: any;
    private _root: Node | null = null;
    private _rows: { node: Node; label: Label }[] = [];
    private _info: Label | null = null;
    private _available = true;

    /** 预设梯度（降序），点击循环 */
    private static readonly SCALE_PRESETS: number[][] = [
        [0.85, 0.7],
        [0.9, 0.8, 0.7],
        [0.9, 0.75, 0.6],
    ];
    private static readonly FPS_PRESETS: number[][] = [
        [60, 30],
        [60, 40, 30],
        [60, 30, 20],
    ];
    private _scaleIdx = 0;
    private _fpsIdx = 0;

    constructor (ctrl: any) {
        this._ctrl = ctrl;
    }

    public build (): void {
        const canvas = this._findCanvas();
        if (!canvas) {
            console.warn('[StressTest] 找不到 Canvas，跳过开发者面板');
            return;
        }
        const ui = canvas.getComponent(UITransform);
        const w = ui ? ui.contentSize.width : 750;
        const h = ui ? ui.contentSize.height : 1334;

        const W = 250;
        const H = 56;
        const GAP = 8;
        const M = 20;

        const root = new Node('DevDashboard');
        root.layer = Layers.Enum.UI_2D;
        canvas.addChild(root);
        const rt = root.addComponent(UITransform);
        rt.setContentSize(W, (H + GAP) * 4 + 50);
        rt.setAnchorPoint(0, 1);
        root.setPosition(-w / 2 + M, h / 2 - M, 0);
        this._root = root;

        // 4 个按钮：2 个开关 + 2 个档位循环
        const specs: { text: string; onTap: () => void }[] = [
            { text: '分辨率温控', onTap: () => this._toggleLever('scale') },
            { text: '帧率温控', onTap: () => this._toggleLever('frameRate') },
            { text: '分辨率档位', onTap: () => this._cycleTiers('scale') },
            { text: '帧率档位', onTap: () => this._cycleTiers('frameRate') },
        ];
        specs.forEach((s, i) => {
            const { node, label } = this._makeButton(root, W, H, -(i * (H + GAP)));
            this._rows.push({ node, label });
            node.on(Node.EventType.TOUCH_END, s.onTap, this);
        });

        // 状态行
        const infoNode = new Node('Info');
        infoNode.layer = Layers.Enum.UI_2D;
        root.addChild(infoNode);
        const it = infoNode.addComponent(UITransform);
        it.setContentSize(W, 40);
        it.setAnchorPoint(0, 1);
        infoNode.setPosition(0, -(4 * (H + GAP) + 4), 0);
        const info = infoNode.addComponent(Label);
        info.fontSize = 18;
        info.lineHeight = 22;
        info.color = new Color(220, 220, 220, 220);
        info.horizontalAlign = Label.HorizontalAlign.LEFT;
        this._info = info;

        const bridge = this._ctrl.thermalBridge;
        this._available = !!bridge && typeof bridge.isThermalAvailable === 'function' && bridge.isThermalAvailable();
        if (!this._available) {
            console.warn('[StressTest] 本包没有 thermal 模块（构建时被裁剪），开发者面板置灰');
        }
        this._refresh();
        console.log('[StressTest] 开发者面板已创建（左上角）');
    }

    private _makeButton (parent: Node, W: number, H: number, top: number): { node: Node; label: Label } {
        const node = new Node('Btn');
        node.layer = Layers.Enum.UI_2D;
        parent.addChild(node);
        const t = node.addComponent(UITransform);
        t.setContentSize(W, H);
        t.setAnchorPoint(0, 1);
        node.setPosition(0, top, 0);

        const g = node.addComponent(Graphics);
        g.fillColor = new Color(60, 60, 60, 195);
        g.roundRect(0, -H, W, H, 10);
        g.fill();

        const ln = new Node('Label');
        ln.layer = Layers.Enum.UI_2D;
        node.addChild(ln);
        const lt = ln.addComponent(UITransform);
        lt.setContentSize(W, H);
        lt.setAnchorPoint(0.5, 0.5);
        ln.setPosition(W / 2, -H / 2, 0);
        const label = ln.addComponent(Label);
        label.string = '';
        label.fontSize = 22;
        label.lineHeight = 26;
        label.color = new Color(255, 255, 255, 255);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        return { node, label };
    }

    // ---- 交互 ----

    private _toggleLever (which: 'scale' | 'frameRate'): void {
        if (!this._available) {
            console.warn('[StressTest] 本包没有 thermal 模块，开关无效');
            return;
        }
        const bridge = this._ctrl.thermalBridge;
        const scope = bridge.leverScope();
        const scaleOn = scope !== 'frameRate';
        const fpsOn = scope !== 'scale';
        const nextScale = which === 'scale' ? !scaleOn : scaleOn;
        const nextFps = which === 'frameRate' ? !fpsOn : fpsOn;
        if (!nextScale && !nextFps) {
            console.warn('[StressTest] 两个杠杆都关掉没有意义，已忽略');
            return;
        }
        bridge.setLeverScope(nextScale && nextFps ? 'both' : (nextScale ? 'scale' : 'frameRate'));
        this._refresh();
    }

    private _cycleTiers (which: 'scale' | 'frameRate'): void {
        if (!this._available) {
            console.warn('[StressTest] 本包没有 thermal 模块，档位不可改');
            return;
        }
        const bridge = this._ctrl.thermalBridge;
        if (which === 'scale') {
            this._scaleIdx = (this._scaleIdx + 1) % DevDashboard.SCALE_PRESETS.length;
            bridge.setScaleTiers(DevDashboard.SCALE_PRESETS[this._scaleIdx]);
        } else {
            this._fpsIdx = (this._fpsIdx + 1) % DevDashboard.FPS_PRESETS.length;
            bridge.setFrameRateTiers(DevDashboard.FPS_PRESETS[this._fpsIdx]);
        }
        if (this._ctrl.csv && this._ctrl.csv.rowCount > 2) {
            console.warn('[StressTest] 本轮已采样 ' + this._ctrl.csv.rowCount
                + ' 行，改档位后这一轮数据不可比——正式实验请先 off → on 重来');
        }
        this._refresh();
    }

    // ---- 渲染 ----

    private _refresh (): void {
        if (!this._available) {
            this._paint(0, '分辨率温控: 关', 'off');
            this._paint(1, '帧率温控: 关', 'off');
            this._paint(2, '分辨率档位: —', 'off');
            this._paint(3, '帧率档位: —', 'off');
            if (this._info) this._info.string = '本包没有温控模块（已裁剪）';
            return;
        }
        const bridge = this._ctrl.thermalBridge;
        const scope = bridge.leverScope();
        this._paint(0, '分辨率温控: ' + (scope === 'frameRate' ? '关' : '开'), scope === 'frameRate' ? 'off' : 'on');
        this._paint(1, '帧率温控: ' + (scope === 'scale' ? '关' : '开'), scope === 'scale' ? 'off' : 'on');

        const tiers = typeof bridge.tiers === 'function' ? bridge.tiers() : { scale: [], frameRate: [] };
        const fmt = (arr: number[]) => (arr && arr.length ? arr.map((v: number) => String(v).replace(/^0\./, '0.')).join('/') : '默认');
        this._paint(2, '分辨率档位: ' + fmt(tiers.scale), 'neutral');
        this._paint(3, '帧率档位: ' + fmt(tiers.frameRate), 'neutral');

        if (this._info) {
            const st = this._ctrl.getStatus ? this._ctrl.getStatus() : null;
            if (st) {
                this._info.string = 'scale ' + st.shadingScale + '｜' + st.frameRate + 'fps｜L' + st.thermalLevel
                    + '｜' + (st.thermalActive ? '温控开' : '温控关');
            } else {
                this._info.string = '';
            }
        }
    }

    /** kind: 'on' 绿（开关打开）/ 'off' 灰 / 'neutral' 蓝（档位这类非开关的行） */
    private _paint (idx: number, text: string, kind: 'on' | 'off' | 'neutral'): void {
        const row = this._rows[idx];
        if (!row) return;
        row.label.string = text;
        const g = row.node.getComponent(Graphics);
        if (g) {
            const t = row.node.getComponent(UITransform)!;
            g.clear();
            g.fillColor = kind === 'on' ? new Color(28, 140, 82, 215)
                : kind === 'neutral' ? new Color(48, 92, 158, 215)
                    : new Color(60, 60, 60, 195);
            g.roundRect(0, -t.contentSize.height, t.contentSize.width, t.contentSize.height, 10);
            g.fill();
        }
    }

    public destroy (): void {
        if (this._root && this._root.isValid) this._root.destroy();
        this._root = null;
        this._rows = [];
    }

    private _findCanvas (): Node | null {
        const scene = director.getScene();
        if (!scene) return null;
        const stack: any[] = [scene];
        while (stack.length) {
            const n = stack.pop();
            if (!n) continue;
            if (n.getComponent && n.getComponent(Canvas)) return n as Node;
            const children = n.children || [];
            for (let i = 0; i < children.length; i++) stack.push(children[i]);
        }
        return null;
    }
}
