import { Node, Label, UITransform, Graphics, Color, Layers, Canvas, director, game } from 'cc';

/**
 * 杠杆开关面板（运行时创建，不改场景）：
 *
 *   [分辨率温控: 开]   [帧率温控: 开]
 *   档位 1.00 / 0.85 / 0.70 ｜ 60 / 30
 *
 * 为什么做这个：正式 A/B 实验里"忘了设杠杆"会白跑 30 分钟——
 * GPU 组忘了关帧率杠杆 → 帧率白降；CPU 组忘了关分辨率杠杆 → 分辨率白降。
 * 一个点击比记命令可靠。
 *
 * 为什么档位只读：档位是引擎在 enable() 时由 buildLevels() 算出来的，改它要重建
 * 控制器，且**每轮换档位会让 A/B 不可比**。要比较不同档位，应该单独做"档位对比实验"，
 * 而不是在 A/B 长测里混着改。所以这里只显示，不给改。
 */
export class LeverPanel {
    private _ctrl: any;
    private _scaleBtn: Node | null = null;
    private _fpsBtn: Node | null = null;
    private _scaleLabel: Label | null = null;
    private _fpsLabel: Label | null = null;
    private _infoLabel: Label | null = null;
    private _root: Node | null = null;

    constructor (ctrl: any) {
        this._ctrl = ctrl;
    }

    public build (): void {
        const canvas = this._findCanvas();
        if (!canvas) {
            console.warn('[StressTest] 找不到 Canvas，跳过杠杆面板');
            return;
        }
        const ui = canvas.getComponent(UITransform);
        const w = ui ? ui.contentSize.width : 750;
        const h = ui ? ui.contentSize.height : 1334;

        const W = 232;
        const H = 64;
        const GAP = 10;
        const M = 24;

        const root = new Node('LeverPanel');
        root.layer = Layers.Enum.UI_2D;
        canvas.addChild(root);
        const rt = root.addComponent(UITransform);
        rt.setContentSize(W, H * 2 + GAP + 40);
        rt.setAnchorPoint(0, 1);
        // 左上角
        root.setPosition(-w / 2 + M, h / 2 - M, 0);

        this._scaleBtn = this._makeButton(root, '分辨率温控', 0, W, H);
        this._scaleLabel = this._scaleBtn.getComponentInChildren(Label);
        this._fpsBtn = this._makeButton(root, '帧率温控', H + GAP, W, H);
        this._fpsLabel = this._fpsBtn.getComponentInChildren(Label);

        const info = new Node('LeverInfo');
        info.layer = Layers.Enum.UI_2D;
        root.addChild(info);
        const it = info.addComponent(UITransform);
        it.setContentSize(W, 30);
        it.setAnchorPoint(0, 1);
        info.setPosition(0, -(H * 2 + GAP + 6), 0);
        const il = info.addComponent(Label);
        il.fontSize = 20;
        il.lineHeight = 24;
        il.color = new Color(230, 230, 230, 220);
        il.horizontalAlign = Label.HorizontalAlign.LEFT;
        this._infoLabel = il;

        this._scaleBtn.on(Node.EventType.TOUCH_END, () => this._toggle('scale'), this);
        this._fpsBtn.on(Node.EventType.TOUCH_END, () => this._toggle('frameRate'), this);

        this._root = root;
        this._refresh();
        console.log('[StressTest] 杠杆面板已创建（左上角）');
    }

    private _makeButton (parent: Node, text: string, top: number, W: number, H: number): Node {
        const btn = new Node('Btn_' + text);
        btn.layer = Layers.Enum.UI_2D;
        parent.addChild(btn);
        const t = btn.addComponent(UITransform);
        t.setContentSize(W, H);
        t.setAnchorPoint(0, 1);
        btn.setPosition(0, -top, 0);

        const g = btn.addComponent(Graphics);
        g.fillColor = new Color(60, 60, 60, 190);
        g.roundRect(0, -H, W, H, 10);
        g.fill();

        const labelNode = new Node('Label');
        labelNode.layer = Layers.Enum.UI_2D;
        btn.addChild(labelNode);
        const lt = labelNode.addComponent(UITransform);
        lt.setContentSize(W, H);
        lt.setAnchorPoint(0.5, 0.5);
        labelNode.setPosition(W / 2, -H / 2, 0);
        const l = labelNode.addComponent(Label);
        l.string = text;
        l.fontSize = 24;
        l.lineHeight = 28;
        l.color = new Color(255, 255, 255, 255);
        l.horizontalAlign = Label.HorizontalAlign.CENTER;
        l.verticalAlign = Label.VerticalAlign.CENTER;
        return btn;
    }

    /** 点击切换一个杠杆，然后把"两个开关的组合"折算成 leverScope 交给引擎 */
    private _toggle (which: 'scale' | 'frameRate'): void {
        const scope = this._ctrl.thermalBridge.leverScope();
        const scaleOn = scope !== 'frameRate';
        const fpsOn = scope !== 'scale';

        let nextScale = scaleOn;
        let nextFps = fpsOn;
        if (which === 'scale') nextScale = !scaleOn;
        else nextFps = !fpsOn;

        if (!nextScale && !nextFps) {
            console.warn('[StressTest] 两个杠杆都关掉没有意义，已忽略');
            return;
        }
        const next = nextScale && nextFps ? 'both' : (nextScale ? 'scale' : 'frameRate');
        this._ctrl.thermalBridge.setLeverScope(next);
        this._refresh();
    }

    private _refresh (): void {
        const scope = this._ctrl.thermalBridge.leverScope();
        const scaleOn = scope !== 'frameRate';
        const fpsOn = scope !== 'scale';
        this._paint(this._scaleBtn, this._scaleLabel, '分辨率温控', scaleOn);
        this._paint(this._fpsBtn, this._fpsLabel, '帧率温控', fpsOn);
        if (this._infoLabel) {
            // 档位是引擎侧的既定梯度，只做展示
            this._infoLabel.string = '档位 1.00 / 0.85 / 0.70 ｜ 60 / 30';
        }
    }

    private _paint (node: Node | null, label: Label | null, name: string, on: boolean): void {
        if (node) {
            const g = node.getComponent(Graphics);
            if (g) {
                g.clear();
                g.fillColor = on ? new Color(28, 140, 82, 210) : new Color(60, 60, 60, 190);
                const t = node.getComponent(UITransform)!;
                g.roundRect(0, -t.contentSize.height, t.contentSize.width, t.contentSize.height, 10);
                g.fill();
            }
        }
        if (label) label.string = name + ': ' + (on ? '开' : '关');
    }

    public destroy (): void {
        if (this._root && this._root.isValid) this._root.destroy();
        this._root = null;
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
