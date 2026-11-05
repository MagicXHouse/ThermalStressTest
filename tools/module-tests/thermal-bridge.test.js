// 运行时测试：thermal-bridge 的配置透传 / 开关 / 手动档位 / 阈值
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require(process.env.CC_ENGINE_TYPESCRIPT || 'D:/proj/cocos/cocos4/node_modules/typescript');

const calls = { enable: [], disable: 0, stepDown: 0, stepUp: 0, setThreshold: [], levelChange: 0, action: 0 };
let fakeLevel = 0;
let fakeState = { level: 0, frameRate: 60, shadingScale: 1.0, scaleEnabled: true, enabled: true, paused: false };

const thermalStub = {
    enable(cfg) { calls.enable.push(cfg); },
    disable() { calls.disable++; },
    stepDown() { calls.stepDown++; return calls.stepDown <= 1; },
    stepUp() { calls.stepUp++; return true; },
    getLevel() { return fakeLevel; },
    getState() { return fakeState; },
    onLevelChange(cb) { calls.levelChange++; },
    onAction(cb) { calls.action++; },
    setThreshold(p) { calls.setThreshold.push(p); },
    setFsrMaterial() { },
};

const ccStub = {
    director: { root: { pipeline: { shadingScale: 1.0, constructor: { name: 'WebPipeline' } } } },
    cclegacy: {},
    Material: class { },
    resources: { load(p, T, cb) { cb(null, { name: 'builtin-fsr' }); } },
    thermal: thermalStub,
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

const { ThermalBridge, THERMAL_LEVEL_NAMES, DowngradeOrder } = loadTs(path.resolve(__dirname, '../../assets/script/thermal-bridge.ts'));

const ctrl = {
    thermalMinFrameRate: 30,
    thermalTriggerPercent: 10,
    thermalMinScale: 0.3,
    thermalWarmupSeconds: 20,
    enableAutoUpgrade: true,
    probeIntervalSeconds: 45,
    recoveryProbeSeconds: 12,
    _findCamera: () => null,
    _log: () => { },
};
const bridge = new ThermalBridge(ctrl);

check('THERMAL_LEVEL_NAMES 三级', THERMAL_LEVEL_NAMES.length === 3 && THERMAL_LEVEL_NAMES[0] === 'Normal');

const logs = [];
const origLog = console.log; console.log = (m) => logs.push(String(m));
bridge.on();
console.log = origLog;

const cfg = calls.enable[0];
check('enable 被调用一次', calls.enable.length === 1);
check('cfg.minFrameRate 透传', cfg.minFrameRate === 30);
check('cfg.minScale 透传', cfg.minScale === 0.3);
check('cfg.warmupSeconds 透传', cfg.warmupSeconds === 20);
check('cfg.enableAutoUpgrade 透传', cfg.enableAutoUpgrade === true);
check('cfg.probeIntervalSeconds 透传', cfg.probeIntervalSeconds === 45);
check('cfg.recoveryProbeSeconds 透传', cfg.recoveryProbeSeconds === 12);
check('cfg.enableFsr = true（31eb2d2 起项目启用 FSR，依赖 custom-pipeline-builtin-scripts）', cfg.enableFsr === true);
check('cfg.downgradeOrder 默认 scale-first', cfg.downgradeOrder === 'scale-first');
check('挂了 levelChange + action 回调', calls.levelChange === 1 && calls.action === 1);
check('DowngradeOrder 枚举: ScaleFirst=0 / FrameRateFirst=1', DowngradeOrder.ScaleFirst === 0 && DowngradeOrder.FrameRateFirst === 1);

// 面板切到 FrameRateFirst 时应透传 frameRate-first
ctrl.downgradeOrder = DowngradeOrder.FrameRateFirst;
const calls2 = { enable: [] };
thermalStub.enable = (c2) => { calls2.enable.push(c2); };
const bridge2 = new ThermalBridge(ctrl);
bridge2.on();
check('cfg.downgradeOrder 切到 frameRate-first', calls2.enable[0] && calls2.enable[0].downgradeOrder === 'frameRate-first', calls2.enable[0] ? calls2.enable[0].downgradeOrder : 'none');

bridge.off();
check('off 调用 thermal.disable', calls.disable === 1);

check('down() 传递 stepDown 返回值', bridge.down() === true);
check('down() 到底时返回 false', bridge.down() === false);
check('up() 返回 true', bridge.up() === true);

fakeLevel = 2;
check('level() 读引擎档位', bridge.level() === 2);

bridge.setTriggerPercent(5);
check('setTriggerPercent 写回控制器', ctrl.thermalTriggerPercent === 5);
check('setTriggerPercent 调 thermal.setThreshold', calls.setThreshold[0] === 5);

// FSR 占位加载
let fsrDone = 0;
bridge.initFsr(() => { fsrDone++; });
check('initFsr 回调被调用', fsrDone === 1);
check('initFsr 后 fsrReady = true', bridge.fsrReady === true);

// diagFsr 在找不到相机时也要能返回结构
const diag = bridge.diagFsr();
check('diagFsr 返回对象', diag && typeof diag === 'object');
check('diagFsr.pipelineClass 有值', diag.pipelineClass === 'WebPipeline', 'value=' + diag.pipelineClass);
check('diagFsr.cameraName 为 null 字串', diag.cameraName === 'null');

// --- 11) P1-2 回归：thermal 被功能裁剪（cc.thermal === undefined）时不能崩 ---
{
    const saved = ccStub.thermal;
    ccStub.thermal = undefined;
    const b = new ThermalBridge(ctrl);
    let done = 0;
    let d = null, u = null, lv = null, diag2 = null;
    let thrown = null;
    try {
        b.initFsr(() => { done++; });
        b.on();                    // 应打印错误后返回，不抛
        b.off();
        d = b.down();
        u = b.up();
        lv = b.level();
        b.setTriggerPercent(7);
        diag2 = b.diagFsr();
    } catch (e) {
        thrown = e;
    } finally {
        ccStub.thermal = saved;
    }
    check('thermal 缺失: 全流程不抛异常', thrown === null, thrown ? String(thrown.message) : 'ok');
    check('thermal 缺失: initFsr 仍回调一次（不卡住启动流程）', done === 1, 'done=' + done);
    check('thermal 缺失: down/up 返回 false', d === false && u === false, d + '/' + u);
    check('thermal 缺失: level() 返回 -1', lv === -1, 'level=' + lv);
    check('thermal 缺失: diagFsr 仍返回结构', !!diag2 && diag2.pipelineClass === 'WebPipeline');
    check('thermal 缺失: diagFsr.thermalFsr = null', diag2 && diag2.thermalFsr === null);
}

const failed = results.filter(r => !r.ok);
console.log('\n==== 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
if (failed.length) { console.log('失败项: ' + failed.map(f => f.name).join(' | ')); process.exitCode = 1; }
