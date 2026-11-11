import { Node, Label, UITransform, Graphics, Color, Layers, Canvas, director } from 'cc';

/**
 * 右上角状态面板（**只读**，运行时创建，不改场景）：
 *
 *   分辨率温控: 开
 *   帧率温控:   关
 *   分辨率档位: 0.85/0.70
 *   帧率档位:   60/30
 *   scale 1.00｜60fps｜L0｜温控开
 *
 * 为什么只读：跑实验时面板只该**告诉现场现在是什么状态**，
 * 实验条件（温控开关、档位梯度）在 Inspector 面板上构建期就定好，
 * 现场改会让"这一轮到底测的是什么"说不清。要看/改状态用 `s('status')` 或命令。
 */
export class StatusPanel {
    private _ctrl: any;
    private _root: Node | null = null;
    private _rows: { node: Node; label: Label }[] = [];
    private _info: Label | null = null;
    private _available = true;

    constructor (ctrl: any) {
        this._ctrl = ctrl;
    }

    public build (): void {
        const canvas = this._findCanvas();
        if (!canvas) {
            console.warn('[StressTest] 找不到 Canvas，跳过状态面板');
            return;
        }
        const ui = canvas.getComponent(UITransform);
        const w = ui ? ui.contentSize.width : 750;
        const h = ui ? ui.contentSize.height : 1334;

        const W = 250;
        const H = 52;
        const GAP = 6;
        const M = 20;
        const ROWS = 4;

        const root = new Node('StatusPanel');
        root.layer = Layers.Enum.UI_2D;
        canvas.addChild(root);
        const panelH = (H + GAP) * ROWS + 46;
        const rt = root.addComponent(UITransform);
        rt.setContentSize(W, panelH);
        rt.setAnchorPoint(0, 1);
        // 右下角、叠在「复制CSV」按钮正上方：右侧对齐同一列，互不遮挡
        // 复制按钮尺寸见 copy-csv-button.ts（168x76，距边 24）
        const COPY_BTN_W = 168;
        const COPY_BTN_H = 76;
        const COPY_BTN_GAP = 8;
        const posX = w / 2 - M - W;
        const posY = -h / 2 + M + COPY_BTN_H + COPY_BTN_GAP + panelH;
        root.setPosition(posX, posY, 0);
        this._root = root;

        for (let i = 0; i < ROWS; i++) {
            this._rows.push(this._makeRow(root, W, H, -(i * (H + GAP))));
        }

        const infoNode = new Node('Info');
        infoNode.layer = Layers.Enum.UI_2D;
        root.addChild(infoNode);
        const it = infoNode.addComponent(UITransform);
        it.setContentSize(W, 40);
        it.setAnchorPoint(0, 1);
        infoNode.setPosition(0, -(ROWS * (H + GAP) + 4), 0);
        const info = infoNode.addComponent(Label);
        info.fontSize = 18;
        info.lineHeight = 22;
        info.color = new Color(225, 225, 225, 230);
        info.horizontalAlign = Label.HorizontalAlign.LEFT;
        this._info = info;

        const bridge = this._ctrl.thermalBridge;
        this._available = !!bridge && typeof bridge.isThermalAvailable === 'function' && bridge.isThermalAvailable();
        if (!this._available) {
            console.warn('[StressTest] 本包没有 thermal 模块（构建时被裁剪），状态面板显示为未启用');
        }
        this.refresh();
        console.log('[StressTest] 状态面板已创建 @ (' + Math.round(posX) + ', ' + Math.round(posY)
            + ')，Canvas ' + Math.round(w) + 'x' + Math.round(h) + '（右下角、复制按钮上方，只读）');
    }

    private _makeRow (parent: Node, W: number, H: number, top: number): { node: Node; label: Label } {
        const node = new Node('Row');
        node.layer = Layers.Enum.UI_2D;
        parent.addChild(node);
        const t = node.addComponent(UITransform);
        t.setContentSize(W, H);
        t.setAnchorPoint(0, 1);
        node.setPosition(0, top, 0);

        const g = node.addComponent(Graphics);
        g.fillColor = new Color(55, 55, 55, 200);
        g.roundRect(0, -H, W, H, 9);
        g.fill();

        const ln = new Node('Label');
        ln.layer = Layers.Enum.UI_2D;
        node.addChild(ln);
        const lt = ln.addComponent(UITransform);
        lt.setContentSize(W - 16, H);
        lt.setAnchorPoint(0.5, 0.5);
        ln.setPosition(W / 2, -H / 2, 0);
        const label = ln.addComponent(Label);
        label.string = '';
        label.fontSize = 20;
        label.lineHeight = 24;
        label.color = new Color(255, 255, 255, 255);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        return { node, label };
    }

    /** 由控制器定时调用（约每 0.5 秒），刷新只读显示 */
    public refresh (): void {
        if (!this._root || !this._root.isValid) return;

        if (!this._available) {
            this._paint(0, '分辨率温控: —', 'off');
            this._paint(1, '帧率温控: —', 'off');
            this._paint(2, '分辨率档位: —', 'off');
            this._paint(3, '帧率档位: —', 'off');
            if (this._info) this._info.string = '本包没有温控模块（已裁剪）';
            return;
        }

        const bridge = this._ctrl.thermalBridge;
        const scope = typeof bridge.leverScope === 'function' ? bridge.leverScope() : 'both';
        const scaleOn = scope !== 'frameRate';
        const fpsOn = scope !== 'scale';
        this._paint(0, '分辨率温控: ' + (scaleOn ? '开' : '关'), scaleOn ? 'on' : 'off');
        this._paint(1, '帧率温控: ' + (fpsOn ? '开' : '关'), fpsOn ? 'on' : 'off');

        const tiers = typeof bridge.tiers === 'function' ? bridge.tiers() : { scale: [], frameRate: [] };
        const fmt = (arr: number[]) => (arr && arr.length ? arr.join('/') : '—');
        this._paint(2, '分辨率档位: ' + fmt(tiers.scale), 'neutral');
        this._paint(3, '帧率档位: ' + fmt(tiers.frameRate), 'neutral');

        if (this._info) {
            const st = typeof this._ctrl.getStatus === 'function' ? this._ctrl.getStatus() : null;
            this._info.string = st
                ? ('scale ' + st.shadingScale + '｜' + st.frameRate + 'fps｜L' + st.thermalLevel
                    + '｜' + (st.thermalActive ? '温控开' : '温控关'))
                : '';
        }
    }

    private _paint (idx: number, text: string, kind: 'on' | 'off' | 'neutral'): void {
        const row = this._rows[idx];
        if (!row) return;
        row.label.string = text;
        const g = row.node.getComponent(Graphics);
        if (!g) return;
        const t = row.node.getComponent(UITransform)!;
        g.clear();
        g.fillColor = kind === 'on' ? new Color(28, 140, 82, 215)
            : kind === 'neutral' ? new Color(46, 88, 152, 215)
                : new Color(58, 58, 58, 200);
        g.roundRect(0, -t.contentSize.height, t.contentSize.width, t.contentSize.height, 9);
        g.fill();
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
