/**
 * 陀螺/角标 PNG 加载（v8：对齐 battle/spintop.js 真机已验证写法 + jsbridge 就绪门禁）
 *
 * 背景：v6 用「15 图 × 3 候选错峰竞速 + 看门狗 + wx.loadImage」，真机恒为矢量；
 *       而 battle/spintop.js 用同一份 utils.prepSrc、同一批 images/<folder>/<file>、
 *       同一个 wx.createImage，只做「一次性建 image + 单次赋 src」，真机稳定出图。
 * v7 改为与 spintop 同构，但仍有两处真机顽疾：① 启动早期 jsbridge 未就绪时发起加载会静默挂起；
 * ② 6s 兜底把真机加载换到 data URI（真机 data URI onload 不可靠，已废弃）。
 * v8 因此：先等 jsbridge 就绪再发首载，兜底改用「新对象 + 另一条包内路径斜杠写法」，
 * 本套件锁死这些行为，防止回退到 v6/v7 的复杂/顽疾机制。
 *
 * 核心断言：
 *   1. 正常路径下每张图**只赋一次 src**（v6 会赋 3 次 → 真机解码队列过载）
 *   2. **不再调用 wx.loadImage**（官方文档查无此 API，v6 的路径 A 在真机从未生效）
 *   3. 真机走包内路径 images/<folder>/<file>，模拟器走内嵌 data URI（由 prepSrc 决定）
 *   4. **首载前先等 jsbridge 就绪**（真机启动早期 getSystemInfoSync 抛"jsbridge not ready"，
 *      此时发起 wx.createImage+包内路径会静默挂起 → 主页/图鉴矢量且不恢复；对战分包晚加载故稳定）
 *   5. 6s 后仍未就绪才对未就绪的图换「**新 image 对象 + 另一条包内路径斜杠写法**」重试一次
 *      （绝不重赋同对象 src——真机重复赋 src 静默作废；绝不换 data URI——真机 data URI onload 不可靠）
 *   6. 任何故障模式下都不抛异常（静默回退矢量）
 */
const path = require('path');
const MOD = path.join(__dirname, '..', 'src', 'beyblade.js');

let pass = 0, fail = 0;
function ok(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + desc + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + desc + (extra ? ' — ' + extra : '')); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TOTAL_IMGS = 35;   // 5 系 + 5 金系 level 专属 + 5 木系 level 专属 + 5 水系 level 专属 + 5 火系 level 专属 + 5 土系 level 专属 + 5 元素角标

function formOf(v) {
  if (typeof v !== 'string') return '?';
  if (v.slice(0, 5) === 'data:') return 'data';
  return v.charAt(0) === '/' ? 'pkg2' : 'pkg';
}

// ── mock ────────────────────────────────────────────────────────────
// pkgMode/pkg2Mode/dataMode: ok=成功 / fail=明确失败 / hang=静默挂起（不触发任何回调）
function installMock(cfg) {
  const rec = { imgs: [], srcLog: [], logs: [], pngDraws: 0, loadImageCalls: 0, sysInfoCalls: 0 };
  const noop = () => {};
  const grad = { addColorStop: noop };

  class MockImage {
    constructor() {
      this.width = 0; this.height = 0; this._ok = false; this._src = ''; this._sets = 0;
      this.onload = null; this.onerror = null;
      rec.imgs.push(this);
    }
    set src(v) {
      this._src = v; this._sets++;
      rec.srcLog.push(formOf(v));
      const mode = formOf(v) === 'data' ? cfg.dataMode : (formOf(v) === 'pkg2' ? cfg.pkg2Mode : cfg.pkgMode);
      if (mode === 'ok') setTimeout(() => { this.width = 256; this.height = 256; this.onload && this.onload(); }, 20);
      else if (mode === 'fail') setTimeout(() => { this.onerror && this.onerror({ errMsg: 'mock fail' }); }, 10);
      // hang：什么都不做
    }
    get src() { return this._src; }
  }

  const ctx2 = {
    drawImage(...a) { if (a[0] instanceof MockImage) rec.pngDraws++; },
    beginPath: noop, arc: noop, save: noop, restore: noop, clip: noop, stroke: noop, fill: noop,
    fillRect: noop, strokeRect: noop, fillText: noop, strokeText: noop, translate: noop,
    rotate: noop, scale: noop, setLineDash: noop, closePath: noop, moveTo: noop, lineTo: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, clearRect: noop, drawFocusIfNeeded: noop,
    createRadialGradient: () => grad, createLinearGradient: () => grad, createPattern: () => null,
    measureText: () => ({ width: 10 }),
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, shadowBlur: 0, shadowColor: '', lineCap: '', lineJoin: '', globalCompositeOperation: ''
  };

  global.wx = {
    getSystemInfoSync() {
      if (cfg.throwSysInfo) {
        rec.sysInfoCalls++;
        if (rec.sysInfoCalls <= (cfg.sysInfoFailN || 1)) throw new Error('jsbridge not ready');
      }
      return { platform: cfg.platform };
    },
    createImage() { return new MockImage(); },
    createOffscreenCanvas(o) {
      const c = { width: o.width, height: o.height };
      c.getContext = () => ctx2;
      return c;
    },
    // v7 不应再调用它（官方文档查无此 API）
    loadImage(opts) {
      rec.loadImageCalls++;
      const mode = formOf(opts.src) === 'data' ? cfg.dataMode
        : (formOf(opts.src) === 'pkg2' ? cfg.pkg2Mode : cfg.pkgMode);
      if (mode === 'ok') setTimeout(() => { const i = new MockImage(); i.width = 256; opts.success && opts.success(i); }, 20);
      else if (mode === 'fail') setTimeout(() => { opts.fail && opts.fail({ errMsg: 'mock fail' }); }, 10);
    }
  };
  global.Image = MockImage;

  const origLog = console.log;
  console.log = function (...a) { if (a[0] === '[topimg]') rec.logs.push(a.slice(1).join(' ')); };
  rec.restore = () => { console.log = origLog; };
  return rec;
}

// 可控时钟：避免真实等待 6s 兜底延迟
let CLOCK = 100000;
const REAL_NOW = Date.now;

async function run(name, cfg, steps) {
  console.log('\n【' + name + '】');
  // 必须清空整段 src/ 模块缓存，而非仅 MOD（beyblade.js）。
  // 原因：imgb64.js 现已把 base64 内联、按 platform 平台相关求值——devtools 下返回完整 data URI，
  // 真机下返回空壳；utils.js 在加载时捕获了 imgb64 引用。若只清 MOD，场景 A(ios) 缓存的
  // 空 imgb64 / utils 会被场景 B(devtools) 复用，导致 prepSrc 误走 /images 兜底而非 data URI。
  // 真机每个平台是独立进程、无此问题；测试在同一进程切平台，必须清缓存以还原「每平台独立求值」。
  const SRC_DIR = path.join(__dirname, '..', 'src');
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(SRC_DIR) === 0) delete require.cache[k];
  }
  CLOCK = 100000;
  Date.now = () => CLOCK;

  const rec = installMock(cfg);
  let B = null, threw = null;
  try { B = require(MOD); } catch (e) { threw = e; }

  const draw = () => {
    try { B.drawBeyblade(Object.assign({}, {
      save() {}, restore() {}, translate() {}, rotate() {}, drawImage() {}, beginPath() {},
      arc() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {}, clip() {}, setLineDash() {}
    }), 0, 0, new B.Beyblade(0, 1), 1); } catch (e) { threw = threw || e; }
  };

  try {
    await steps({ rec, draw, advance: (ms) => { CLOCK += ms; } });
  } catch (e) { threw = threw || e; }

  rec.restore();
  Date.now = REAL_NOW;
  delete require.cache[require.resolve(MOD)];
  delete global.wx; delete global.Image;

  const state = {
    rec, threw,
    ready: rec.imgs.filter(i => i._ok && i.width > 0).length,
    sets: rec.imgs.reduce((s, i) => s + i._sets, 0),
    forms: [...new Set(rec.srcLog)]
  };
  return state;
}

(async () => {
  console.log('陀螺 PNG 加载 v8（对齐 battle/spintop.js + jsbridge 就绪门禁）：一次性建 image + 单次赋 src');

  // ── A 真机主路径：包内路径直接成功 ──────────────────────────────
  let s = await run('A 真机：包内路径成功', { platform: 'ios', pkgMode: 'ok', pkg2Mode: 'ok', dataMode: 'ok' },
    async ({ draw, advance }) => {
      draw();                 // 首帧：只记录时机（v7 延迟发起）
      advance(900);           // 快进过 _START_DELAY(800ms)
      draw();                 // 触发 _startLoadOnce，发起加载
      await sleep(120);       // 等 onload
      draw();                 // 再绘制一次，此时应已就绪
    });
  ok('不抛异常', !s.threw, s.threw && s.threw.message);
  ok('35 张图全部就绪', s.ready === TOTAL_IMGS, s.ready + '/' + TOTAL_IMGS);
  ok('src 形态为包内路径 images/<folder>/<file>（无前导斜杠）', s.forms.length === 1 && s.forms[0] === 'pkg', JSON.stringify(s.forms));
  ok('【v7 核心】每张图只赋一次 src（共 35 次，v6 会是 63 次）', s.sets === TOTAL_IMGS, '实际 ' + s.sets + ' 次');
  ok('【v7 核心】未调用 wx.loadImage（官方文档查无此 API）', s.rec.loadImageCalls === 0, s.rec.loadImageCalls + ' 次');
  ok('PNG 已绘入 sprite（sprite 内 drawImage 被触发）', s.rec.pngDraws > 0, s.rec.pngDraws + ' 次');

  // ── B 模拟器：data URI ──────────────────────────────────────────
  s = await run('B 模拟器：内嵌 data URI', { platform: 'devtools', pkgMode: 'fail', pkg2Mode: 'fail', dataMode: 'ok' },
    async ({ draw, advance }) => { draw(); advance(900); draw(); await sleep(120); draw(); });
  ok('不抛异常', !s.threw, s.threw && s.threw.message);
  ok('35 张图全部就绪', s.ready === TOTAL_IMGS, s.ready + '/' + TOTAL_IMGS);
  ok('src 形态为 data URI（模拟器不碰包内路径）', s.forms.length === 1 && s.forms[0] === 'data', JSON.stringify(s.forms));
  ok('【v7 核心】每张图只赋一次 src', s.sets === TOTAL_IMGS, '实际 ' + s.sets + ' 次');

  // ── C 真机包内路径(无斜杠)静默挂起 → 6s 后换「新对象 + /images 斜杠写法」─
  s = await run('C 真机：包内路径(无斜杠)静默挂起 → 6s 兜底换[新对象+/images斜杠]', { platform: 'ios', pkgMode: 'hang', pkg2Mode: 'ok', dataMode: 'ok' },
    async ({ draw, advance }) => {
      draw();                 // jsbridge 就绪 → 首发 images/...（无斜杠，挂起）
      await sleep(80);
      advance(7000);          // 快进过 6s 兜底阈值
      draw();                 // 触发兜底：新对象 + /images/...（有斜杠，ok）
      await sleep(120);       // 等新对象 onload
      draw();
    });
  ok('不抛异常', !s.threw, s.threw && s.threw.message);
  ok('兜底后 35 张图全部就绪', s.ready === TOTAL_IMGS, s.ready + '/' + TOTAL_IMGS);
  ok('确实换了路（images/... → /images/...，新对象）', s.forms.indexOf('pkg') >= 0 && s.forms.indexOf('pkg2') >= 0, JSON.stringify(s.forms));
  ok('换路只发生一次（共 70 次 = 35 首发 + 35 兜底新对象）', s.sets === TOTAL_IMGS * 2, '实际 ' + s.sets + ' 次');

  // ── D 真机包内路径(无斜杠)明确 fail → 兜底换 /images 斜杠写法 ───
  s = await run('D 真机：包内路径(无斜杠)明确 fail → 兜底换 /images 斜杠写法', { platform: 'ios', pkgMode: 'fail', pkg2Mode: 'ok', dataMode: 'ok' },
    async ({ draw, advance }) => { draw(); await sleep(80); advance(7000); draw(); await sleep(120); draw(); });
  ok('不抛异常', !s.threw, s.threw && s.threw.message);
  ok('兜底后 35 张图全部就绪', s.ready === TOTAL_IMGS, s.ready + '/' + TOTAL_IMGS);
  ok('确实换了路（images/... → /images/...）', s.forms.indexOf('pkg') >= 0 && s.forms.indexOf('pkg2') >= 0, JSON.stringify(s.forms));

  // ── E jsbridge 先未就绪(2 次)后就绪：就绪后才发加载 ─────────────
  s = await run('E 真机：jsbridge 先未就绪(2次)后就绪 → 就绪后再发加载', { platform: 'ios', pkgMode: 'ok', pkg2Mode: 'ok', dataMode: 'ok', throwSysInfo: true, sysInfoFailN: 2 },
    async ({ draw }) => {
      draw();                 // #1: jsbridge 未就绪 → 静默等待
      draw();                 // #2: jsbridge 未就绪 → 静默等待
      draw();                 // #3: jsbridge 就绪 → 发起包内路径加载
      await sleep(120);       // 等 onload
      draw();                 // #4: 全部就绪
    });
  ok('不抛异常（jsbridge 未就绪时静默等待，不崩）', !s.threw, s.threw && s.threw.message);
  ok('jsbridge 就绪后走包内路径且全部就绪', s.ready === TOTAL_IMGS, s.ready + '/' + TOTAL_IMGS);
  ok('全程未调用 wx.loadImage', s.rec.loadImageCalls === 0, s.rec.loadImageCalls + ' 次');

  // ── F 全部来源静默挂起：不静默、不崩（物理上不可能出图）────────
  s = await run('F 全部来源静默挂起：不崩 + 留可观测日志', { platform: 'ios', pkgMode: 'hang', pkg2Mode: 'hang', dataMode: 'hang' },
    async ({ draw, advance }) => { draw(); await sleep(60); advance(7000); draw(); await sleep(60); draw(); });
  ok('不抛异常', !s.threw, s.threw && s.threw.message);
  ok('未就绪时静默回退矢量（不白屏、不崩）', s.ready === 0, s.ready + ' 张就绪');
  ok('留了 [topimg] 诊断日志（真机可排查）', s.rec.logs.length > 0, s.rec.logs.length + ' 条');

  console.log('\n────────────────────────');
  console.log((fail === 0 ? '✅' : '❌') + ' 陀螺 PNG 加载 v8 套件：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
