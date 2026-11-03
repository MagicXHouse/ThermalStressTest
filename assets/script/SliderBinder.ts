import { _decorator, Component, Label, Slider } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('SliderBinder')
export class SliderBinder extends Component {

    @property(Slider)
    public slider: Slider | null = null;

    @property(Label)
    public valueLabel: Label | null = null;

    @property({ tooltip: '最小值' })
    public min: number = 0;

    @property({ tooltip: '最大值' })
    public max: number = 100;

    @property({ tooltip: '步长，0 表示连续' })
    public step: number = 0;

    @property({ tooltip: '初始值' })
    public initialValue: number = 0;

    @property({ tooltip: '显示的小数位数' })
    public decimals: number = 0;

    @property({ tooltip: '后缀，比如 x、°/s' })
    public suffix: string = '';

    @property({ tooltip: '停止拖动多久后触发回调（毫秒）' })
    public debounceMs: number = 250;

    private _value: number = 0;
    private _hasValue: boolean = false;
    private _callback: ((value: number) => void) | null = null;
    private _suppressEvent: boolean = false;
    private _debounceTimer: any = null;

    start() {
        if (!this.slider) {
            console.error(`[SliderBinder] ${this.node.name} 没有设置 Slider 属性！`);
            return;
        }

        if (!this._hasValue) {
            this._value = this.initialValue;
            this._hasValue = true;
        }

        this.bindSliderEvents();
        this.syncSliderFromValue();
        this.refreshLabel();
        console.log(`[SliderBinder] ${this.node.name} 初始化完成，value=${this._value}`);
    }

    onDestroy() {
        this.unbindSliderEvents();
        if (this._debounceTimer !== null) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
    }

    /** 注册变化回调（拖动停止后触发） */
    public onChange(callback: (value: number) => void) {
        this._callback = callback;
    }

    /** 设置值，silent=true 时不触发回调 */
    public setValue(value: number, silent: boolean = false) {
        value = this.clampAndSnap(value);
        this._value = value;
        this._hasValue = true;
        this.syncSliderFromValue();
        this.refreshLabel();
        if (!silent && this._callback) {
            this._callback(this._value);
        }
    }

    public getValue(): number {
        return this._value;
    }

    // ============ 事件绑定 ============

    private bindSliderEvents() {
        if (!this.slider || !this.slider.node) return;
        this.slider.node.off('slide', this.onSliding, this);
        this.slider.node.on('slide', this.onSliding, this);
    }

    private unbindSliderEvents() {
        if (!this.slider) return;
        const node = this.slider.node;
        if (!node || !node.isValid) return;
        node.off('slide', this.onSliding, this);
    }

    // ============ 滑动回调 ============

    private onSliding() {
        if (this._suppressEvent || !this.slider) return;

        const next = this.calcValueFromProgress();
        if (next === this._value) {
            return;
        }
        this._value = next;
        this.refreshLabel();

        if (this._debounceTimer !== null) {
            clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            if (this._callback) {
                this._callback(this._value);
            }
        }, this.debounceMs);
    }

    // ============ 数值计算 ============

    private calcValueFromProgress(): number {
        if (!this.slider) return this._value;
        const raw = this.min + (this.max - this.min) * this.slider.progress;
        return this.clampAndSnap(raw);
    }

    private clampAndSnap(value: number): number {
        if (this.step > 0) {
            value = Math.round(value / this.step) * this.step;
        }
        return Math.min(this.max, Math.max(this.min, value));
    }

    private syncSliderFromValue() {
        if (!this.slider) return;
        const range = this.max - this.min;
        const progress = range > 0 ? (this._value - this.min) / range : 0;

        this._suppressEvent = true;
        this.slider.progress = Math.min(1, Math.max(0, progress));

        this.scheduleOnce(() => {
            this._suppressEvent = false;
        }, 0);
    }

    private refreshLabel() {
        if (this.valueLabel) {
            this.valueLabel.string = this._value.toFixed(this.decimals) + this.suffix;
        }
    }
}