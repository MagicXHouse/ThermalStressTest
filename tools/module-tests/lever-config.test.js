// 回归：面板勾选必须传进 thermal.enable(cfg)
//
// 背景（真机 bug）：StressTestController.applyLeverSwitches() 在 enable() 之前写
// config.enableScale=false，但 thermal-bridge 的 on() 里 enableScale 被**硬编码成 true**，
// 于是 enable(cfg) 合并配置时把它覆盖回 true —— 结果"没勾分辨率温控也降分辨率"，
// 那一轮实验数据作废。
//
// 这个用例直接验证 on() 产出的 cfg，不依赖其它测试的状态。
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require(process.env.CC_ENGINE_TYPESCRIPT || 'D:/proj/cocos/cocos4/node_modules/typescript');

const results = [];
function check (name, cond, detail) {
    results.push({ name, ok: !!cond });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
}

function loadBridge () {
    const file = path.resolve(__dirname, '../../assets/script/thermal-bridge.ts');
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true },
    }).outputText;

    const captured = [];
    const thermalStub = {
        enable (cfg) { captured.push(cfg); },
        disable () { /* noop */ },
        stepDown () { return false; },
        stepUp () { return false; },
        getLevel () { return 0; },
        getState () { return { level: 0, frameRate: 60, shadingScale: 1, enabled: true, paused: false }; },
        getShadingScale () { return 1; },
        onLevelChange () { /* noop */ },
        onAction () { /* noop */ },
        setThreshold () { /* noop */ },
        setDowngradeOrder () { /* noop */ },
    };
    const ccStub = {
        director: { root: { pipeline: { shadingScale: 1, constructor: { name: 'WebPipeline' } } } },
        cclegacy: {},
        Material: class { },
        resources: { load (p, T, cb) { cb(null, {}); } },
        thermal: thermalStub,
    };

    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === 'cc') return 'cc-lever-stub';
        return origResolve.call(this, request, ...rest);
    };
    require.cache['cc-lever-stub'] = {
        id: 'cc-lever-stub', filename: 'cc-lever-stub', loaded: true, exports: ccStub,
    };

    const m = new Module(file, null);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(js, file);

    Module._resolveFilename = origResolve;
    return { ThermalBridge: m.exports.ThermalBridge, captured };
}

const { ThermalBridge, captured } = loadBridge();

const mkCtrl = (scale, fps) => ({
    thermalMinFrameRate: 20,
    thermalTriggerPercent: 10,
    thermalMinScale: 0.7,
    thermalWarmupSeconds: 20,
    enableAutoUpgrade: false,
    probeIntervalSeconds: 60,
    recoveryProbeSeconds: 60,
    downgradeOrder: 0,
    enableFsr: true,
    enableScaleControl: scale,
    enableFrameRateControl: fps,
    _findCamera: () => null,
    _log: () => { /* noop */ },
});

// 1) 只勾帧率：enableScale 必须是 false（这就是那个真机 bug）
new ThermalBridge(mkCtrl(false, true)).on();
const c1 = captured[captured.length - 1];
check('未勾分辨率温控 -> enableScale=false', c1 && c1.enableScale === false,
    'enableScale=' + (c1 && c1.enableScale));
check('勾了帧率温控 -> enableFrameRate=true', c1 && c1.enableFrameRate === true,
    'enableFrameRate=' + (c1 && c1.enableFrameRate));

// 2) 两个都勾
new ThermalBridge(mkCtrl(true, true)).on();
const c2 = captured[captured.length - 1];
check('两个都勾 -> enableScale=true', c2 && c2.enableScale === true, 'enableScale=' + (c2 && c2.enableScale));
check('两个都勾 -> enableFrameRate=true', c2 && c2.enableFrameRate === true,
    'enableFrameRate=' + (c2 && c2.enableFrameRate));

// 3) 只勾分辨率（GB 场景）
new ThermalBridge(mkCtrl(true, false)).on();
const c3 = captured[captured.length - 1];
check('未勾帧率温控 -> enableFrameRate=false', c3 && c3.enableFrameRate === false,
    'enableFrameRate=' + (c3 && c3.enableFrameRate));
check('勾了分辨率温控 -> enableScale=true', c3 && c3.enableScale === true, 'enableScale=' + (c3 && c3.enableScale));

const failed = results.filter((r) => !r.ok);
console.log('\n==== 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
if (failed.length) {
    console.log('失败项: ' + failed.map((f) => f.name).join(' | '));
    process.exitCode = 1;
}
