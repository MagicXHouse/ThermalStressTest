import { Node, Label, UITransform, Graphics, Color, Layers, Canvas, director } from 'cc';

/**
 * 左下角一个"复制CSV"按钮：点击把当前已采集的 CSV（含表头）复制到系统剪贴板。
 *
 * 为什么不用 `Button` 组件：`Button` 的点击依赖 `target` 上的 Sprite/过渡，
 * 纯代码创建时还要塞 SpriteFrame，反而更脆。这里直接用 `Node.EventType.TOUCH_END`
 * ——只要节点有 `UITransform` 且挂在 `Canvas` 下，触摸命中就够了。
 *
 * 为什么运行时创建而不是编进场景：现在只是"一个按钮"，等做完整操作面板时
 * 这个节点会被并到面板里；写进场景反而要改场景文件、还得同步 JSON。
 */
export class CopyCsvButton {
    private _ctrl: any;
    private _root: Node | null = null;

    constructor (ctrl: any) {
        this._ctrl = ctrl;
    }

    /** 创建按钮；找不到 Canvas 时静默跳过（不让测试工程因为 UI 崩掉） */
    public build (): void {
        const canvas = this._findCanvas();
        if (!canvas) {
            console.warn('[StressTest] 找不到 Canvas，跳过"复制CSV"按钮');
            return;
        }
        const ui = canvas.getComponent(UITransform);
        const w = ui ? ui.contentSize.width : 750;
        const h = ui ? ui.contentSize.height : 1334;

        const W = 168;
        const H = 76;
        const M = 24;

        const node = new Node('CopyCsvButton');
        node.layer = Layers.Enum.UI_2D;
        canvas.addChild(node);

        const t = node.addComponent(UITransform);
        t.setContentSize(W, H);
        t.setAnchorPoint(0, 0);
        // Canvas 的锚点在中心，所以左下角要从 (-w/2, -h/2) 起算
        node.setPosition(-w / 2 + M, -h / 2 + M, 0);

        const g = node.addComponent(Graphics);
        g.fillColor = new Color(0, 0, 0, 150);
        g.roundRect(0, 0, W, H, 14);
        g.fill();

        const labelNode = new Node('Label');
        labelNode.layer = Layers.Enum.UI_2D;
        node.addChild(labelNode);
        const lt = labelNode.addComponent(UITransform);
        lt.setContentSize(W, H);
        lt.setAnchorPoint(0.5, 0.5);
        labelNode.setPosition(W / 2, H / 2, 0);
        const label = labelNode.addComponent(Label);
        label.string = '复制CSV';
        label.fontSize = 28;
        label.lineHeight = 32;
        label.color = new Color(255, 255, 255, 255);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;

        node.on(Node.EventType.TOUCH_END, this._onClick, this);

        this._root = node;
        console.log('[StressTest] "复制CSV"按钮已创建（左下角 ' + W + 'x' + H + '）');
    }

    /** 移除按钮（后续并进操作面板时会用到） */
    public destroy (): void {
        if (this._root && this._root.isValid) {
            this._root.off(Node.EventType.TOUCH_END, this._onClick, this);
            this._root.destroy();
        }
        this._root = null;
    }

    private _onClick (): void {
        const r = this._ctrl && typeof this._ctrl.copyCsv === 'function' ? this._ctrl.copyCsv(0) : null;
        if (r && r.copied) {
            this._toast('已复制 ' + r.rows + ' 行');
        } else if (r && r.reason === 'no-data') {
            this._toast('还没有数据');
        } else {
            this._toast('复制失败（仅微信小游戏支持）');
        }
    }

    private _toast (msg: string): void {
        const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
        const wx = g.wx;
        if (wx && typeof wx.showToast === 'function') {
            try {
                wx.showToast({ title: msg, icon: 'none', duration: 1500 });
            } catch (e) { /* toast 失败不影响复制本身 */ }
        }
        console.log('[StressTest] ' + msg);
    }

    /** 递归找 Canvas（只在启动时调一次） */
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
