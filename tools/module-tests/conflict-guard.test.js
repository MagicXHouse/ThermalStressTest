// 运行时断言：温控与 DRS 抢 shadingScale 的互斥防护
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require(process.env.CC_ENGINE_TYPESCRIPT || 'D:/proj/cocos/cocos4/node_modules/typescript');

const fakePipeline = { shadingScale: 0.3 };
const ccStub = {
    _decorator: { ccclass: () => (t) => t, property: () => () => { } },
    Component: class { },
    Node: class { },
    Prefab: class { },
    instantiate: (x) => x,
    profiler: { showStats() { } },
    Enum: (x) => x,
    Toggle: class { },
    Label: class { },
    Vec3: class { },
    Vec4: class { },
    Quat: class { },
    Color: class { },
    MeshRenderer: class { },
    ParticleSystem: class { },
    Canvas: class { },
    Camera: class { },
    Layers: { Enum: { UI_2D: 1 << 25, UI_3D: 1 << 23, DEFAULT: 1 << 30 } },
    Material: class { },
    screen: { windowSize: { width: 1280, height: 720 } },
    director: { root: { pipeline: fakePipeline } },
    game: { frameRate: 60 },
    cclegacy: { rendering: { forceResizeAllWindows() { } } },
    resources: { load() { } },
    thermal: {
        enable() { }, disable() { }, stepDown() { return true; }, stepUp() { return true; },
        getLevel() { return 0; }, getState() { return { level: 0, frameRate: 60, shadingScale: 1, scaleEnabled: true, enabled: true, paused: false }; },
        onLevelChange() { }, onAction() { }, setThreshold() { },
    },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'cc') return 'cc-stub';
    try {
        return origResolve.call(this, request, parent, ...rest);
    } catch (e) {
        // 兄弟模块是 .ts（无扩展名 import），补一次 .ts 解析
        if (request.startsWith('.')) {
            try { return origResolve.call(this, request + '.ts', parent, ...rest); } catch (e2) { throw e; }
        }
        throw e;
    }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'cc') return ccStub;
    return origLoad.call(this, request, parent, isMain);
};

// 让 require 能直接加载 .ts
Module._extensions['.ts'] = function (module, filename) {
    const src = fs.readFileSync(filename, 'utf8');
    const js = ts.transpileModule(src, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019,
            experimentalDecorators: true, emitDecoratorMetadata: false,
        },
        fileName: filename,
    }).outputText;
    module._compile(js, filename);
};

function loadTs(file) {
    return require(file);
}

const results = [];
function check(name, cond, detail) {
    results.push({ name, ok: !!cond });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
}

const { StressTestController } = loadTs(path.resolve(__dirname, '../../assets/script/StressTestController.ts'));

function makeCtrl() {
    const c = new StressTestController();
    c.enableThermalControl = true;
    c.autoToggleDrs = true;
    c.drs = { started: 0, start() { this.started++; }, stop() { }, updateLabel() { } };
    c.thermalBridge = { fsrReady: false };
    c.planes = { count: 3 };
    c.cubes = { count: 0 };
    c.csv = { lastFps: 42, sampling: true, rowCount: 7 };
    return c;
}

// 1) 冲突检测：两者都开 → 关 DRS + error
const logs = [];
const origErr = console.error;
console.error = (...a) => logs.push(a.join(' '));
const c1 = makeCtrl();
const resolved = c1['_resolveDrsConflict']();
console.error = origErr;
check('两者同开时检测到冲突', resolved === true);
check('冲突后 autoToggleDrs 被置 false', c1.autoToggleDrs === false);
check('冲突时打了 error（不静默）', logs.some(l => l.includes('配置冲突')), logs[0] && logs[0].slice(0, 40));

// 2) 不冲突的情形
const c2 = makeCtrl(); c2.enableThermalControl = false;
check('温控关闭时不干预', c2['_resolveDrsConflict']() === false && c2.autoToggleDrs === true);
const c3 = makeCtrl(); c3.enableThermalControl = true; c3.autoToggleDrs = false;
check('温控开但 DRS 本来就关 → 不算冲突', c3['_resolveDrsConflict']() === false);

// 3) startDrsToggle 在温控开启时拒绝执行
const c4 = makeCtrl();
console.error = (...a) => logs.push(a.join(' '));
c4.startDrsToggle();
console.error = origErr;
check('温控开启时 startDrsToggle 拒绝启动', c4.drs.started === 0);
check('拒绝时打了 error', logs.some(l => l.includes('拒绝启动 DRS')));
c4.enableThermalControl = false;
c4.startDrsToggle();
check('温控关闭后 startDrsToggle 正常启动', c4.drs.started === 1);

// 4) setScale 在温控开启时告警
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => warns.push(a.join(' '));
const c5 = makeCtrl();
c5.setScale(0.7);
console.warn = origWarn;
check('温控开启时 setScale 给出告警', warns.some(l => l.includes('接管 shadingScale')));
check('setScale 仍然写入了 pipeline', fakePipeline.shadingScale === 0.7, 'scale=' + fakePipeline.shadingScale);

// 5) getStatus 暴露冲突标记
const c6 = makeCtrl();
c6['_resolveDrsConflict']();
const st = c6.getStatus();
check('getStatus 暴露 drsConflict=true', st.drsConflict === true);
check('getStatus 暴露 thermalOn/drsAutoToggle', st.thermalOn === true && st.drsAutoToggle === false);
const c7 = makeCtrl(); c7.enableThermalControl = false; c7['_resolveDrsConflict']();
check('无冲突时 drsConflict=false', c7.getStatus().drsConflict === false);

const failed = results.filter(r => !r.ok);
console.log('\n==== 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
if (failed.length) { console.log('失败项: ' + failed.map(f => f.name).join(' | ')); process.exitCode = 1; }
