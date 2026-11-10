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
check('CSV 表头为 15 列且顺序不变', cols.length === 15 && cols[0] === 'elapsed_s' && cols[13] === 'drop_rate' && cols[14] === 'drop_rate_cur', cols.length + ' 列');

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
const dataLines = captured.filter(l => l.startsWith('[StressTest] ') && !l.includes('frame-time sampling') && l.split(',').length === 15);
check('第 2 行同样是 15 列', dataLines.length >= 1, dataLines.length + ' 行');
if (dataLines.length) {
    const c = dataLines[0].replace('[StressTest] ', '').split(',');
    check('load_gpu_layers = planes.count(3)', c[8] === '3', 'col=' + c[8]);
    check('spawn_count = cubes.count(5)', c[9] === '5', 'col=' + c[9]);
    check('shading_scale 读 pipeline(0.85)', c[10] === '0.85', 'col=' + c[10]);
    check('frame_rate = 60', c[11] === '60', 'col=' + c[11]);
    check('battery_pct 非微信为 NA', c[7] === 'NA', 'col=' + c[7]);
    check('fps ≈ 62.5（16ms/帧）', Math.abs(parseFloat(c[2]) - 62.5) < 0.2, 'fps=' + c[2]);
}

// --- 7b) T04：稳定 33.3ms/帧 + 目标 30fps 时，drop_rate(旧口径)=100 而 drop_rate_cur(新口径)≈0 ---
{
    const rec30 = new CsvRecorder({ writeCsv: false, planes: { count: 1 }, cubes: { count: 0 }, _log: () => { } });
    ccStub.game.frameRate = 60;        // 采样起点目标 60fps → 旧口径预算冻结在 16.67ms
    rec30.start();
    ccStub.game.frameRate = 30;        // 温控把目标降到 30fps
    captured = [];
    console.log = (...a) => { captured.push(a.join(' ')); };
    for (let t = 0; t < 5200; t += 33.3) { fakeNow += 33.3; rec30.tick(); }   // 稳定 33.3ms/帧
    console.log = origLog;
    const l30 = captured.find(l => l.startsWith('[StressTest] ') && l.split(',').length === 15);
    const p = l30 ? l30.replace('[StressTest] ', '').split(',') : null;
    check('T04: 目标降到 30 后旧口径 drop_rate 仍报 100', p && parseFloat(p[13]) > 95, p ? p[13] : 'none');
    check('T04: 同一行新口径 drop_rate_cur ≈ 0（当前档位是稳的）', p && parseFloat(p[14]) < 5, p ? p[14] : 'none');
    rec30.stop();
}
ccStub.game.frameRate = 30;          // 恢复给下一段用

ccStub.game.frameRate = 30;          // 模拟温控把帧率降到 30
captured = [];
console.log = (...a) => { captured.push(a.join(' ')); };
for (let t = 0; t < 5200; t += 16) { fakeNow += 16; rec.tick(); }
console.log = origLog;
const line30 = captured.find(l => l.startsWith('[StressTest] ') && l.split(',').length === 15);
check('降帧后 frame_rate 列变成 30', line30 && line30.split(',')[11] === '30', line30 ? line30.split(',')[11] : 'none');
check('降帧后 fps_std 仍是有效数值', line30 && !Number.isNaN(parseFloat(line30.split(',')[12])), line30 ? line30.split(',')[12] : 'none');

// --- 7c) P1-1 回归：掉帧判据有 5% 容差，满帧 60fps（16.67ms/帧）不应报掉帧 ---
{
    const rec60 = new CsvRecorder({ writeCsv: false, planes: { count: 1 }, cubes: { count: 0 }, _log: () => { } });
    ccStub.game.frameRate = 60;
    rec60.start();
    captured = [];
    console.log = (...a) => { captured.push(a.join(' ')); };
    for (let t = 0; t < 5200; t += 1000 / 60) { fakeNow += 1000 / 60; rec60.tick(); }
    console.log = origLog;
    const l60 = captured.find(l => l.startsWith('[StressTest] ') && l.split(',').length === 15);
    const q = l60 ? l60.replace('[StressTest] ', '').split(',') : null;
    check('P1-1: 满帧 60fps 的 drop_rate = 0（容差生效）', q && parseFloat(q[13]) === 0, q ? q[13] : 'none');
    check('P1-1: 满帧 60fps 的 drop_rate_cur = 0', q && parseFloat(q[14]) === 0, q ? q[14] : 'none');
    rec60.stop();
}

// --- 8) stop 后不再出数据 ---
rec.stop();
const beforeStop = rec.rowCount;
for (let t = 0; t < 6000; t += 16) { fakeNow += 16; rec.tick(); }
check('stop 后 tick 不再产生新行', rec.rowCount === beforeStop, 'rows=' + rec.rowCount + ' (before=' + beforeStop + ')');
check('stop 后 lastFps 仍可读（不清零）', rec.lastFps > 0, 'lastFps=' + rec.lastFps.toFixed(1));

// --- 9) 再 start 会清空旧行 ---
rec.start();
check('重新 start 后行数回到 1（表头）', rec.rowCount === 1, 'rows=' + rec.rowCount);

// --- 10) T07：定时快照用固定名覆盖写，归档导出带 A/B 标识 ---
{
    const written = [];
    global.wx = {
        env: { USER_DATA_PATH: '/vfs' },
        getFileSystemManager: () => ({
            writeFile: (o) => { written.push(o.filePath); if (o.success) o.success(); },
        }),
    };
    const recW = new CsvRecorder({ writeCsv: true, planes: { count: 1 }, cubes: { count: 0 }, enableThermalControl: true, isThermalActive: () => true, _log: () => { } });
    recW.start();
    for (let t = 0; t < 5200; t += 16) { fakeNow += 16; recW.tick(); }

    recW.autoExport();
    check('T07: autoExport 写固定名 thermal_latest.csv', written[written.length - 1] === '/vfs/thermal_latest.csv', written[written.length - 1]);

    recW.exportCsv();
    const arch = written[written.length - 1];
    check('T07: 归档导出带 B 标识且带时间戳', /^\/vfs\/thermal_B_\d+\.csv$/.test(arch), arch);
    check('T07: 归档导出不是 latest（两者分开）', arch !== '/vfs/thermal_latest.csv');

    // A（温控关）应当写 thermal_A_*
    const recA = new CsvRecorder({ writeCsv: true, planes: { count: 1 }, cubes: { count: 0 }, enableThermalControl: false, isThermalActive: () => false, _log: () => { } });
    recA.start();
    for (let t = 0; t < 5200; t += 16) { fakeNow += 16; recA.tick(); }
    recA.exportCsv();
    const archA = written[written.length - 1];
    check('T07: 温控关时归档带 A 标识', /^\/vfs\/thermal_A_\d+\.csv$/.test(archA), archA);

    // 面板关、但运行时手动 s('on') 开了温控 → 必须标成 AX，不能冒充 baseline
    const recMix = new CsvRecorder({ writeCsv: true, planes: { count: 1 }, cubes: { count: 0 }, enableThermalControl: false, isThermalActive: () => true, _log: () => { } });
    recMix.start();
    for (let t = 0; t < 5200; t += 16) { fakeNow += 16; recMix.tick(); }
    recMix.exportCsv();
    const archMix = written[written.length - 1];
    check('T07: 面板关但运行时开着 → 标 AX（不冒充 baseline）', /^\/vfs\/thermal_AX_\d+\.csv$/.test(archMix), archMix);

    delete global.wx;
}

// --- T08：切后台产生的几十秒长间隔必须被丢弃，不能污染 ft_avg/ft_max（S-04 的代码侧保障）---
{
    const recGap = new CsvRecorder({ writeCsv: false, planes: { count: 1 }, cubes: { count: 0 }, _log: () => { } });
    recGap.start();
    // 稳定 5.2 秒（16ms/帧）
    for (let t = 0; t < 5200; t += 16) { fakeNow += 16; recGap.tick(); }
    const before = recGap.gaps;
    // 模拟切后台 30 秒：下一 tick 的 delta = 30000ms
    fakeNow += 30000;
    recGap.tick();
    check('T08: 30s 长间隔被计数（不 push）', recGap.gaps === before + 1, 'gaps=' + recGap.gaps);

    // 回来后继续正常跑 5.2 秒
    const logs = [];
    const origLog2 = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    for (let t = 0; t < 5200; t += 16) { fakeNow += 16; recGap.tick(); }
    console.log = origLog2;

    const lines = logs.filter(l => l.startsWith('[StressTest] ') && l.split(',').length === 15);
    const parsed = lines.map(l => l.replace('[StressTest] ', '').split(','));
    const maxFt = Math.max(...parsed.map(c => parseFloat(c[5])).filter(v => !isNaN(v)));
    const avgFt = Math.max(...parsed.map(c => parseFloat(c[3])).filter(v => !isNaN(v)));
    check('T08: 切后台后 ft_max 不含 30000ms 脏值', maxFt < 1000, 'ft_max=' + maxFt);
    check('T08: 切后台后 ft_avg 不被拉高', avgFt < 100, 'ft_avg=' + avgFt);
}

// --- T09：复制到剪贴板（copyCsv）---
{
    let clip = null;
    global.wx = {
        env: { USER_DATA_PATH: '/vfs' },
        setClipboardData: (o) => { clip = o.data; if (o.success) o.success(); },
    };
    const rec = new CsvRecorder({ writeCsv: true, planes: { count: 1 }, cubes: { count: 0 }, enableThermalControl: false, isThermalActive: () => false, _log: () => { } });
    rec.start();
    for (let t = 0; t < 16000; t += 16) { fakeNow += 16; rec.tick(); }

    const r1 = rec.copyCsv();
    const lines1 = clip.split('\n');
    check('T09: 复制全部带上表头', lines1[0].startsWith('elapsed_s,ts_ms,fps'), lines1[0].slice(0, 20));
    check('T09: 复制行数与数据行一致', lines1.length - 1 === r1.rows && r1.rows >= 3, 'rows=' + r1.rows);
    check('T09: 返回摘要而不是全文', r1.copied === true && typeof r1.bytes === 'number', JSON.stringify(r1));

    const r2 = rec.copyCsv(2);
    const lines2 = clip.split('\n');
    check('T09: 复制最近 2 行（仍带表头）', lines2.length === 3 && r2.rows === 2, 'lines=' + lines2.length);

    delete global.wx;
}

global.performance = realPerf;
const failed = results.filter(r => !r.ok);console.log('\n==== 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
if (failed.length) { console.log('失败项: ' + failed.map(f => f.name).join(' | ')); process.exitCode = 1; }
