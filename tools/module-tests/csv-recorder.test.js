// 用 node 直接跑拆分出来的 csv-recorder：stub 掉 cc，验证 5 秒窗口 → 一行 CSV 的行为
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require(process.env.CC_ENGINE_TYPESCRIPT || 'D:/proj/cocos/cocos4/node_modules/typescript');

let fakeNow = 1000;
const fakePipeline = { shadingScale: 0.85 };
const ccStub = {
    game: { frameRate: 60 },
    director: { root: { pipeline: fakePipeline } },
};

// 拦截 require('cc')
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

// performance.now 由我们控制
const realPerf = global.performance;
global.performance = { now: () => fakeNow };

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
    results.push({ name, ok: !!cond, detail });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
}

const file = path.resolve(__dirname, '../../assets/script/csv-recorder.ts');
const { CsvRecorder, CSV_HEADER } = loadTs(file);

// --- 1) 表头 ---
const cols = CSV_HEADER.split(',');
check('CSV 表头为 14 列且顺序不变', cols.length === 14 && cols[0] === 'elapsed_s' && cols[13] === 'drop_rate', cols.length + ' 列');

// --- 2) 构造与初始状态 ---
const ctrl = { writeCsv: false, planes: { count: 3 }, cubes: { count: 5 }, _log: () => { } };
const rec = new CsvRecorder(ctrl);
check('初始不在采样', rec.sampling === false);
check('初始行数 0', rec.rowCount === 0);

// --- 3) start：立刻有表头，elapsed 从 0 计 ---
rec.start();
check('start 后进入采样', rec.sampling === true);
check('start 后只有表头 1 行', rec.rowCount === 1, 'rows=' + rec.rowCount);

// --- 4) 5 秒内不出行 ---
let rowsSeen = 0;
rec.onRow = () => { rowsSeen++; };
for (let t = 0; t < 4900; t += 16) { fakeNow += 16; rec.tick(); }
check('4.9s 内不出数据行', rec.rowCount === 1, 'rows=' + rec.rowCount);

// --- 5) 跨过 5 秒，出第一行 ---
for (let t = 0; t < 400; t += 16) { fakeNow += 16; rec.tick(); }
check('跨过 5s 后出 1 行数据', rec.rowCount === 2, 'rows=' + rec.rowCount);
check('onRow 回调被调用一次', rowsSeen === 1, 'calls=' + rowsSeen);

// --- 6) 行内容正确性 ---
const row = require('module'); // noop
const lines = (() => {
    // 用 printCsv 的路径拿不到返回值，改为重新驱动一次并解析 console
    return null;
})();
const origLog = console.log;
let captured = [];
console.log = (...args) => { captured.push(args.join(' ')); };
for (let t = 0; t < 5100; t += 16) { fakeNow += 16; rec.tick(); }
console.log = origLog;
const dataLines = captured.filter(l => l.startsWith('[StressTest] ') && !l.includes('frame-time sampling') && l.split(',').length === 14);
check('第 2 行同样是 14 列', dataLines.length >= 1, dataLines.length + ' 行');
if (dataLines.length) {
    const c = dataLines[0].replace('[StressTest] ', '').split(',');
    check('load_gpu_layers = planes.count(3)', c[8] === '3', 'col=' + c[8]);
    check('spawn_count = cubes.count(5)', c[9] === '5', 'col=' + c[9]);
    check('shading_scale 读 pipeline(0.85)', c[10] === '0.85', 'col=' + c[10]);
    check('frame_rate = 60', c[11] === '60', 'col=' + c[11]);
    check('battery_pct 非微信为 NA', c[7] === 'NA', 'col=' + c[7]);
    check('fps ≈ 62.5（16ms/帧）', Math.abs(parseFloat(c[2]) - 62.5) < 0.2, 'fps=' + c[2]);
}

// --- 7) 关温控降帧后，drop_rate/jank 仍用采样基准预算（60fps=16.667ms）---
ccStub.game.frameRate = 30;          // 模拟温控把帧率降到 30
captured = [];
console.log = (...a) => { captured.push(a.join(' ')); };
for (let t = 0; t < 5200; t += 16) { fakeNow += 16; rec.tick(); }
console.log = origLog;
const line30 = captured.find(l => l.startsWith('[StressTest] ') && l.split(',').length === 14);
check('降帧后 frame_rate 列变成 30', line30 && line30.split(',')[11] === '30', line30 ? line30.split(',')[11] : 'none');
check('降帧后 fps_std 仍是有效数值', line30 && !Number.isNaN(parseFloat(line30.split(',')[12])), line30 ? line30.split(',')[12] : 'none');

// --- 8) stop 后不再出数据 ---
rec.stop();
const beforeStop = rec.rowCount;
for (let t = 0; t < 6000; t += 16) { fakeNow += 16; rec.tick(); }
check('stop 后 tick 不再产生新行', rec.rowCount === beforeStop, 'rows=' + rec.rowCount + ' (before=' + beforeStop + ')');
check('stop 后 lastFps 仍可读（不清零）', rec.lastFps > 0, 'lastFps=' + rec.lastFps.toFixed(1));

// --- 9) 再 start 会清空旧行 ---
rec.start();
check('重新 start 后行数回到 1（表头）', rec.rowCount === 1, 'rows=' + rec.rowCount);

global.performance = realPerf;
const failed = results.filter(r => !r.ok);
console.log('\n==== 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
if (failed.length) { console.log('失败项: ' + failed.map(f => f.name).join(' | ')); process.exitCode = 1; }
