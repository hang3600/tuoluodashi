// 启动性能 + 内存优化回归（2026-09-02 体验分报告）
// 运行：node tests/smoke_perf_startup_mem.js   （聚合：node tests/run.js）
//
// 覆盖四项改动：
//  A. P0-A 首包剔除真机死重：4 个 base64 shim 加入 game.json packOptions.ignore
//     —— 真机从不读（prepSrc 真机分支直接返回包内路径），但那 964KB 每次冷启动都要下载+解析。
//     ⚠️ 铁律：shim 的 require 必须全部 try/catch 守卫，否则真机「模块缺失」直接崩。
//  B. P1-a 离屏画布探测：永久闭锁 _offscreenBroken → 指数退避重探（2s→4s→8s…上限 60s）。
//     旧实现因首帧 jsbridge 未就绪失败一次就永久退化，注释「下次重新尝试」与代码自相矛盾。
//  C. P1-b 背景位图释放：离屏画布须显式 width=0/height=0 才释放 native 后备存储，
//     光置 null 交 GC 不保证及时回收（配合 U10-B「切视图释放背景」避免累积）。
//  D. P2 死代码：src/render-effects.js（317 行，全项目无引用）已移出。

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(p, 'utf8'); }

// ═══════════════════════════════════════════════════════════════
// A1. game.json 打包排除（源码级）
// ═══════════════════════════════════════════════════════════════
console.log('【A1】game.json packOptions.ignore 剔除真机死重');
const gj = JSON.parse(read(path.join(ROOT, 'game.json')));
const ignoreVals = ((gj.packOptions && gj.packOptions.ignore) || []).map(function (x) { return x.value; });

// ⚠️ 2026-09-02 真机实测教训：DevTools「预览/上传」打包读的是 project.config.json 的 packOptions.ignore，
// game.json 的 ignore 只作用于官方/云构建链。两份必须都配，否则真机包死重依旧
// （真机日志 [assets] imgb64/homebg/codexbg 三行 = shim 模块级日志仍在执行，即未被排除的铁证）。
const pcj = JSON.parse(read(path.join(ROOT, 'project.config.json')));
const pcIgnoreVals = ((pcj.packOptions && pcj.packOptions.ignore) || []).map(function (x) { return x.value; });

ok('排除 src/imgb64.js（549KB，真机从不读）', ignoreVals.indexOf('src/imgb64.js') >= 0);
ok('排除 src/homebg.js（50KB，真机返回 null）', ignoreVals.indexOf('src/homebg.js') >= 0);
ok('排除 src/codexbg.js（15KB，真机返回 null）', ignoreVals.indexOf('src/codexbg.js') >= 0);
ok('排除 battle/arenabg.js（340KB，真机走包内 JPG）', ignoreVals.indexOf('battle/arenabg.js') >= 0);
ok('排除 .trash_deadcode（死代码回收目录不得入包）', ignoreVals.indexOf('.trash_deadcode') >= 0);
ok('images/ 未被排除（真机唯一资源来源）', ignoreVals.indexOf('images') < 0);

console.log('【A1-c】project.config.json 同步排除（DevTools 预览/上传真实口径）');
ok('pc: 排除 src/imgb64.js（549KB）', pcIgnoreVals.indexOf('src/imgb64.js') >= 0);
ok('pc: 排除 src/homebg.js（50KB）', pcIgnoreVals.indexOf('src/homebg.js') >= 0);
ok('pc: 排除 src/codexbg.js（15KB）', pcIgnoreVals.indexOf('src/codexbg.js') >= 0);
ok('pc: 排除 battle/arenabg.js（340KB）', pcIgnoreVals.indexOf('battle/arenabg.js') >= 0);
ok('pc: 排除 .trash_deadcode（回收目录不得入包）', pcIgnoreVals.indexOf('.trash_deadcode') >= 0);
ok('pc: images/ 未被排除（真机唯一资源来源）', pcIgnoreVals.indexOf('images') < 0);
ok('pc: 排除 _bak_* 备份目录（408KB，曾长期漏排入真机包）',
  ['_bak_woodlv_before_replace', '_bak_firelv_before_replace', '_bak_waterlv_before_replace'].every(function (v) { return pcIgnoreVals.indexOf(v) >= 0; }));
ok('pc: 排除 4 份审计 md（含 09-02，防漏排入真机包）',
  ['整体审计-游戏化改造方案-2026-08-31.md', '跨平台审计报告-2026-08-30.md', '跨平台审计报告-2026-09-02.md', '自检报告-2026-08-30.md'].every(function (v) { return pcIgnoreVals.indexOf(v) >= 0; }));
ok('game.json: 排除 跨平台审计报告-2026-09-02.md', ignoreVals.indexOf('跨平台审计报告-2026-09-02.md') >= 0);

// 文件必须仍在磁盘上：DevTools 本地编译不受 ignore 影响，模拟器预览照旧走 base64
console.log('【A1-b】shim 文件仍保留在磁盘（DevTools 本地编译可用）');
ok('src/imgb64.js 仍在磁盘', fs.existsSync(path.join(SRC, 'imgb64.js')));
ok('src/homebg.js 仍在磁盘', fs.existsSync(path.join(SRC, 'homebg.js')));
ok('src/codexbg.js 仍在磁盘', fs.existsSync(path.join(SRC, 'codexbg.js')));
ok('battle/arenabg.js 仍在磁盘', fs.existsSync(path.join(ROOT, 'battle', 'arenabg.js')));

// ═══════════════════════════════════════════════════════════════
// A2. require 守卫（真机打包排除后不得崩）
// ═══════════════════════════════════════════════════════════════
console.log('【A2】shim require 全部 try/catch 守卫（否则真机模块缺失直接崩）');
const utilsSrc = read(path.join(SRC, 'utils.js'));
const renderSrc = read(path.join(SRC, 'render.js'));
const beybladeSrc = read(path.join(SRC, 'beyblade.js'));
const spintopSrc = read(path.join(ROOT, 'battle', 'spintop.js'));

ok('utils.js：imgb64 require 已守卫', /try\s*\{\s*imgb64\s*=\s*require\('\.\/imgb64'\)/.test(utilsSrc));
ok('utils.js：不再是裸 require（const imgb64 = require）', !/const\s+imgb64\s*=\s*require\('\.\/imgb64'\)/.test(utilsSrc));
ok('render.js：homebg require 已守卫', /try\s*\{\s*return require\('\.\/homebg'\)/.test(renderSrc));
ok('render.js：codexbg require 已守卫', /try\s*\{\s*return require\('\.\/codexbg'\)/.test(renderSrc));
ok('beyblade.js：imgb64 require 已守卫', /try\s*\{\s*return require\('\.\/imgb64'\)/.test(beybladeSrc));
ok('spintop.js：arenabg require 已守卫', /try\s*\{\s*return require\('\.\/arenabg'\)/.test(spintopSrc));

// ═══════════════════════════════════════════════════════════════
// B. 离屏画布探测：指数退避重探（P1-a）
// ═══════════════════════════════════════════════════════════════
console.log('【B】离屏画布：永久闭锁 → 指数退避重探');
const savedWx = global.wx, savedDoc = global.document;
delete global.wx;
delete global.document;

const B = require(path.join(SRC, 'beyblade.js'));
ok('导出 offscreenDisabled 探测函数', typeof B.offscreenDisabled === 'function');
ok('源码已无 _offscreenBroken 永久闭锁', beybladeSrc.indexOf('_offscreenBroken') < 0);

B._offscreenOnOk(); // 从干净状态开始
ok('初始状态：离屏可用', B.offscreenDisabled(1000) === false);

B._offscreenOnFail(1000);
ok('失败后立即可禁用', B.offscreenDisabled(1000) === true);
ok('1.9s 内仍禁用（退避 2s 未到）', B.offscreenDisabled(2900) === true);
ok('2s 后恢复可重探', B.offscreenDisabled(3000) === false);

B._offscreenOnFail(3000);
ok('第 2 次失败退避 4s：4.9s 仍禁用', B.offscreenDisabled(6900) === true);
ok('第 2 次失败退避 4s：4s 后恢复', B.offscreenDisabled(7000) === false);

B._offscreenOnFail(7000);
ok('第 3 次失败退避 8s：7.9s 仍禁用', B.offscreenDisabled(14900) === true);
ok('第 3 次失败退避 8s：8s 后恢复', B.offscreenDisabled(15000) === false);

for (var i = 0; i < 20; i++) B._offscreenOnFail(100000);
ok('退避封顶 60s：59.9s 仍禁用', B.offscreenDisabled(159900) === true);
ok('退避封顶 60s：60s 后恢复重探', B.offscreenDisabled(160000) === false);

B._offscreenOnOk();
ok('成功后计数清零、立即可用', B.offscreenDisabled(160000) === false);

// ═══════════════════════════════════════════════════════════════
// C. 背景位图释放：离屏画布后备存储归零（P1-b）
// ═══════════════════════════════════════════════════════════════
console.log('【C】背景位图释放：离屏画布显式归零后备存储');
const { Renderer } = require(path.join(SRC, 'render.js'));

const fakeCanvas = { width: 750, height: 1334, dpr: 2 };
const noop = function () {};
const fakeCtx = new Proxy({}, {
  get: function (t, p) {
    if (p === 'canvas') return fakeCanvas;
    if (p === 'measureText') return function () { return { width: 10 }; };
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return function () { return { addColorStop: noop }; };
    return noop;
  },
  set: function () { return true; }
});
const fakeGame = {
  view: 'codex', perfLevel: 'LOW',
  canRefill: function () { return false; }, canWatchAdEnergy: function () { return false; },
  homeV2: true, energy: 0, maxEnergy: 100,
  inventory: [], platformSlots: [null, null, null], collection: [],
  filterTier: -1, pityEpic: 0, pityLegend: 0, drawCard: false, signOpen: false, tutorialDone: true
};

let r = null;
try { r = new Renderer(fakeCanvas, fakeCtx, fakeGame); } catch (e) { /* 下方断言兜底 */ }
ok('Renderer 可实例化（无 wx/无 document）', !!r);

if (r) {
  // C-1 离屏画布：必须归零后备存储
  var mockCv = { width: 480, height: 720, getContext: function () { return {}; } };
  r.game.view = 'codex';
  r._homeBgImage = mockCv;
  r._homeBgTried = true;
  r._codexBgImage = null;
  r._codexBgTried = false;
  r._releaseInactiveBg();
  ok('离屏画布后备存储已归零（width=0/height=0）', mockCv.width === 0 && mockCv.height === 0,
    mockCv.width + 'x' + mockCv.height);
  ok('离屏画布引用已置空', r._homeBgImage === null);
  ok('_homeBgTried 已重置（允许切回重载）', r._homeBgTried === false);

  // C-2 原始 wx.Image：无后备存储可归零，只丢引用
  var plainImg = { _ok: true, width: 480, height: 720 };
  r.game.view = 'home';
  r._codexBgImage = plainImg;
  r._codexBgTried = true;
  r._homeBgImage = null;
  r._homeBgTried = false;
  r._releaseInactiveBg();
  ok('原始 Image 不被归零（无 getContext，非离屏画布）', plainImg.width === 480, String(plainImg.width));
  ok('原始 Image 引用已置空', r._codexBgImage === null);
  ok('_codexBgTried 已重置', r._codexBgTried === false);

  // C-3 归零抛异常时不外泄（部分平台 canvas.width 是只读 getter）
  var boom = {
    getContext: function () { return {}; },
    get width() { return 100; },
    set width(v) { throw new Error('readonly'); },
    get height() { return 100; },
    set height(v) { throw new Error('readonly'); }
  };
  r.game.view = 'codex';
  r._homeBgImage = boom;
  r._homeBgTried = true;
  var threw = false;
  try { r._releaseInactiveBg(); } catch (e) { threw = true; }
  ok('归零抛异常时不外泄（不打断渲染帧）', threw === false);
  ok('归零异常后引用仍被置空', r._homeBgImage === null);
}

// ═══════════════════════════════════════════════════════════════
// D. 死代码清理（P2）
// ═══════════════════════════════════════════════════════════════
console.log('【D】死代码：src/render-effects.js 已移出');
ok('src/render-effects.js 已不存在', !fs.existsSync(path.join(SRC, 'render-effects.js')));

var stillRefs = [];
[['src', renderSrc], ['src', beybladeSrc], ['battle', spintopSrc]].forEach(function (pair) {
  if (/require\(['"]\.\/render-effects['"]\)/.test(pair[1])) stillRefs.push(pair[0]);
});
['main.js', 'game.js', 'input.js', 'audio.js', 'ads.js', 'analytics.js'].forEach(function (f) {
  var fp = path.join(SRC, f);
  if (fs.existsSync(fp) && /require\(['"]\.\/render-effects['"]\)/.test(read(fp))) stillRefs.push('src/' + f);
});
ok('无任何模块 require render-effects（真·孤儿）', stillRefs.length === 0, stillRefs.join(','));

// ═══════════════════════════════════════════════════════════════
// A3. 端到端：模拟 imgb64 模块缺失（真机打包排除后的真实运行环境）
// ═══════════════════════════════════════════════════════════════
console.log('【A3】模拟 imgb64 从包中缺失（packOptions.ignore 生效后的真机环境）');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === './imgb64') throw new Error("module './imgb64' not found (simulated packOptions.ignore)");
  return origLoad.apply(this, arguments);
};
let utilsMod = null, loadErr = null;
try {
  var utilsPath = path.join(SRC, 'utils.js');
  delete require.cache[require.resolve(utilsPath)];
  utilsMod = require(utilsPath);
} catch (e) {
  loadErr = e;
} finally {
  Module._load = origLoad;
}
ok('imgb64 缺失时 utils.js 仍能加载（真机不崩）', !loadErr && !!utilsMod, loadErr && loadErr.message);

if (utilsMod) {
  global.wx = { getSystemInfoSync: function () { return { platform: 'ios' }; } };
  var realSrc = utilsMod.prepSrc(null, 'gold-lv3.png', 'tops');
  ok('真机 prepSrc 返回包内路径（与 imgb64 是否存在无关）', realSrc === 'images/tops/gold-lv3.png', realSrc);

  global.wx = { getSystemInfoSync: function () { return { platform: 'devtools' }; } };
  var devSrc = utilsMod.prepSrc(null, 'gold-lv3.png', 'tops');
  ok('模拟器分支 imgb64 缺失时不崩、回退包内路径',
    typeof devSrc === 'string' && devSrc.indexOf('tops/gold-lv3.png') >= 0, devSrc);

  var arenaSrc = utilsMod.prepSrc(null, 'arena_neon_bg.jpg', 'arena');
  global.wx = { getSystemInfoSync: function () { return { platform: 'ios' }; } };
  var arenaReal = utilsMod.prepSrc(null, 'arena_neon_bg.jpg', 'arena');
  ok('模拟器分支 arena 回退带前导斜杠的 /battle/images/arena/...',
    arenaSrc === '/battle/images/arena/arena_neon_bg.jpg', arenaSrc);
  ok('真机 arena 走分包路径 battle/images/arena/...（无前导斜杠）',
    arenaReal === 'battle/images/arena/arena_neon_bg.jpg', arenaReal);
  delete global.wx;
}

// ═══════════════════════════════════════════════════════════════
// E. 包体预算（防回弹：任何死重被塞回来都会立刻红）
// ═══════════════════════════════════════════════════════════════
console.log('【E】包体预算（按 project.config.json packOptions.ignore = 真机预览/上传真实下载量）');
const CFG_FILES = ['project.config.json', 'project.private.config.json', 'game.json', 'jsconfig.json'];
function isIgnored(rel) {
  const parts = rel.split(path.sep);
  for (let i = 0; i < parts.length - 1; i++) {
    if (pcIgnoreVals.indexOf(parts[i]) >= 0) return true;
  }
  return pcIgnoreVals.indexOf(rel) >= 0 || pcIgnoreVals.indexOf(parts[parts.length - 1]) >= 0;
}
function measure(relRoot) {
  let bytes = 0;
  const stack = [relRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(ROOT, dir)); } catch (e) { continue; }
    for (const name of entries) {
      if (name === '.git' || name === 'node_modules') continue;
      const rel = dir ? path.join(dir, name) : name;
      let st = null;
      try { st = fs.statSync(path.join(ROOT, rel)); } catch (e) { continue; }
      if (st.isDirectory()) { stack.push(rel); continue; }
      if (isIgnored(rel)) continue;
      if (CFG_FILES.indexOf(rel) >= 0) continue;
      bytes += st.size;
    }
  }
  return bytes;
}
const mainBytes = measure('') - measure('battle');
const subBytes = measure('battle');
const mainKBs = mainBytes / 1024, subKBs = subBytes / 1024;
console.log('    实测：主包 ' + mainKBs.toFixed(1) + ' KB，battle 分包 ' + subKBs.toFixed(1) + ' KB');
ok('主包 ≤ 1600 KB（基线 2039 KB，剔除死重后应 ~1419 KB）', mainBytes <= 1600 * 1024, mainKBs.toFixed(1) + ' KB');
ok('battle 分包 ≤ 450 KB（基线 688 KB，剔除 arenabg 后应 ~349 KB）', subBytes <= 450 * 1024, subKBs.toFixed(1) + ' KB');
ok('主包未超微信 4096 KB 上限', mainBytes < 4096 * 1024, mainKBs.toFixed(1) + ' KB');

// 还原全局环境
if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
if (savedDoc === undefined) delete global.document; else global.document = savedDoc;

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
