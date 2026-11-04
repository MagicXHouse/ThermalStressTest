// 运行时测试：heat-plane 的着色映射/alpha 补偿 + drs-probe 的切换循环
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require(process.env.CC_ENGINE_TYPESCRIPT || 'D:/proj/cocos/cocos4/node_modules/typescript');

class FakeColor {
    constructor(r, g, b, a) { this.r = r; this.g = g; this.b = b; this.a = a; }
}
class FakeMeshRenderer { }
const fakePipeline = { shadingScale: 1.0 };
const ccStub = {
    Node: class { }, Vec3: class { }, Vec4: class { }, Quat: class { },
    MeshRenderer: FakeMeshRenderer,
    ParticleSystem: class { }, Camera: class { }, Canvas: class { }, Layers: { Enum: { UI_2D: 1 << 25, UI_3D: 1 << 23, DEFAULT: 1 << 30 } },
    director: { root: { pipeline: fakePipeline } },
    screen: { windowSize: { width: 1280, height: 720 } },
    game: { frameRate: 60 },
    instantiate: (x) => x,
    Color: FakeColor,
    Material: class { },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'cc') return 'cc-stub';
    return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'cc') return ccStub;
    return origLoad.call(this, request, parent, isMain);
};

function loadTs(file) {
    const src = fs.readFileSync(file, 'utf8');
    const js = ts.transpileModule(src, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
        fileName: file,
    }).outputText;
    const m = new Module(file, null);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(js, file);
    return m.exports;
}

const results = [];
function check(name, cond, detail) {
    results.push({ name, ok: !!cond });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
}

// ============ heat-plane 着色 ============
const hp = loadTs(path.resolve(__dirname, '../../assets/script/heat-plane.ts'));
const { HeatPlaneRig, TintMode } = hp;

const lastTint = { v: null };
const fakeMat = {
    name: 'Mat_HeatShader3D', isValid: true,
    setProperty(k, v) { lastTint.v = v; },
    getProperty() { return lastTint.v; },
};
const fakeNode = { isValid: true, getComponent: () => ({ sharedMaterial: fakeMat }) };

const ctrl = {
    heatPlane: fakeNode,
    tintMode: TintMode.Load,
    pressureRange: 0.4,
    enableThermalControl: false,
    planeCoverage: 1,
    cubes: { count: 0 },
};
const rig = new HeatPlaneRig(ctrl);

// 内部 _count 通过 setCount 影响（这里直接改私有字段：测试目的）
rig['_count'] = 1;
rig.updateTint();
check('Load 模式 1 层 → 蓝色 (40,120,255)', lastTint.v.r === 40 && lastTint.v.g === 120 && lastTint.v.b === 255,
    `rgb(${lastTint.v.r},${lastTint.v.g},${lastTint.v.b}) a=${lastTint.v.a}`);
check('1 层 alpha = round(0.45*255/1) = 115', lastTint.v.a === 115, 'a=' + lastTint.v.a);

rig['_count'] = 8;
rig.updateTint();
check('Load 模式 8 层 → 红色 (255,25,35)', lastTint.v.r === 255 && lastTint.v.g === 25 && lastTint.v.b === 35,
    `rgb(${lastTint.v.r},${lastTint.v.g},${lastTint.v.b})`);
check('8 层 alpha 按层数补偿 = round(0.78*255/8) = 25', lastTint.v.a === 25, 'a=' + lastTint.v.a);

ctrl.tintMode = TintMode.Off;
const before = lastTint.v;
rig.updateTint();
check('Off 模式不写材质', lastTint.v === before);

// Pressure 模式：帧时间 EMA → p → 颜色
ctrl.tintMode = TintMode.Pressure;
ccStub.game.frameRate = 60;              // 预算 16.67ms
rig['_ftEma'] = 0; rig['_tintTimer'] = 0; rig['_pressureP'] = 0;
for (let i = 0; i < 30; i++) rig.tickPressureTint(0.025);   // 25ms/帧，超预算 50%
check('Pressure 模式超预算后 p 落在 (0,1]', rig['_pressureP'] > 0 && rig['_pressureP'] <= 1, 'p=' + rig['_pressureP'].toFixed(3));
check('Pressure 模式下颜色偏红（r > b）', lastTint.v.r > lastTint.v.b, `rgb(${lastTint.v.r},${lastTint.v.g},${lastTint.v.b})`);

// 4Hz 节流：窗口内的 tick 不应重写材质
rig['_tintTimer'] = 0;
const tintBefore = lastTint.v;
rig.tickPressureTint(0.1);
check('4Hz 节流：0.1s 内不重写材质', lastTint.v === tintBefore);
rig.tickPressureTint(0.2);                       // 累计 0.3s ≥ 0.25s
check('累计过 0.25s 后重写一次材质', lastTint.v !== tintBefore);

// 模式切换
rig.setTintMode('pressure');
check("setTintMode('pressure')", ctrl.tintMode === TintMode.Pressure);
rig.setTintMode('off');
check("setTintMode('off')", ctrl.tintMode === TintMode.Off);
rig.setTintMode('乱写');
check("setTintMode(非法值) 回落到 Load", ctrl.tintMode === TintMode.Load);

// ============ drs-probe ============
const dp = loadTs(path.resolve(__dirname, '../../assets/script/drs-probe.ts'));
const { DrsProbe } = dp;

let scale = null;
let scheduled = null;
let unscheduled = null;
const label = { string: '' };
const drsCtrl = {
    drsToggleInterval: 10,
    drsLowScale: 0.3,
    drsLabel: label,
    enableThermalControl: false,
    csv: { lastFps: 40 },
    setScale(s) { scale = s; },
    schedule(fn, interval) { scheduled = { fn, interval }; },
    unschedule(fn) { unscheduled = fn; },
};
const drs = new DrsProbe(drsCtrl);
drs.start();
check('start 后先跑基线 scale=1.00', scale === 1.0, 'scale=' + scale);
check('schedule 间隔 = drsToggleInterval(10s)', scheduled && scheduled.interval === 10);
check('label 显示 shadingScale 1.00 + fps', label.string.indexOf('shadingScale 1.00') === 0 && label.string.indexOf('40.0 fps') > 0, label.string);

const logs = [];
const origLog = console.log; console.log = (m) => logs.push(String(m));
scheduled.fn();                        // 触发一次切换
console.log = origLog;
check('切一次后 scale = drsLowScale(0.30)', scale === 0.3, 'scale=' + scale);
check('日志含 上一档实测 40.0fps', logs.some(l => l.includes('DRS 1.00 → 0.30') && l.includes('40.0fps')), logs[0]);

drs.stop();
check('stop 调用了 unschedule', typeof unscheduled === 'function');
check('stop 后 scale 还原 1.00', scale === 1.0, 'scale=' + scale);

const failed = results.filter(r => !r.ok);
console.log('\n==== 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
if (failed.length) { console.log('失败项: ' + failed.map(f => f.name).join(' | ')); process.exitCode = 1; }
