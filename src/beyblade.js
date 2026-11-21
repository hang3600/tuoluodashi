/**
 * 陀螺数据与绘制
 */

// 真实陀螺 PNG 数字资产（五行系统）：土→木→水→火→金，金是传说级
const _topFiles = ['top-earth.png', 'top-wood.png', 'top-water.png', 'top-fire.png', 'top-metal.png'];
const _topImgs = [];

// 元素角标真实 PNG（五行系统）：金/木/水/火/土
const _elFiles = { metal: 'icon-metal.png', wood: 'icon-wood.png', water: 'icon-water.png', fire: 'icon-fire.png', earth: 'icon-earth.png' };
const _elImgs = {};

// 金系（metal/tierIndex=4）传说级按 level 1~5 使用专属贴图（gold-lv1.png ~ gold-lv5.png）
const _goldImgs = [];

// 木系（wood/tierIndex=1）稀有级按 level 1~5 使用专属贴图（wood-lv1.png ~ wood-lv5.png）
const _woodLevelFiles = ['wood-lv1.png', 'wood-lv2.png', 'wood-lv3.png', 'wood-lv4.png', 'wood-lv5.png'];
const _woodImgs = [];

// 水系（water/tierIndex=2）史诗级按 level 1~5 使用专属贴图（water-lv1.png ~ water-lv5.png）
const _waterLevelFiles = ['water-lv1.png', 'water-lv2.png', 'water-lv3.png', 'water-lv4.png', 'water-lv5.png'];
const _waterImgs = [];

// 火系（fire/tierIndex=3）精英级按 level 1~5 使用专属贴图（fire-lv1.png ~ fire-lv5.png）
const _fireLevelFiles = ['fire-lv1.png', 'fire-lv2.png', 'fire-lv3.png', 'fire-lv4.png', 'fire-lv5.png'];
const _fireImgs = [];

// 土系（earth/tierIndex=0）普通级按 level 1~5 使用专属贴图（earth-lv1.png ~ earth-lv5.png）
const _earthLevelFiles = ['earth-lv1.png', 'earth-lv2.png', 'earth-lv3.png', 'earth-lv4.png', 'earth-lv5.png'];
const _earthImgs = [];

// 真实资产（陀螺/图标）已外置为包内 PNG 文件（images/tops、images/icons）。
// src 统一由 utils.prepSrc 产出：模拟器 → 内嵌 data URI；真机 → 包内路径。
// 与 battle/spintop.js、src/render.js 用的是同一个函数、同一批文件。
const { prepSrc: _prepSrc } = require('./utils');

// ── 真实 PNG 加载（v8：对齐 battle/spintop.js 真机已验证写法 + jsbridge 就绪门禁）────
// 真机事实对照（三者共用同一份 utils.prepSrc、同一批 images/<folder>/<file>、同一个 wx.createImage）：
//   ✅ battle/spintop.js  loadTopPNGs / loadHudPNGs ——「一次性建 image + 单次 im.src」真机稳定出图
//   ✅ src/render.js      _loadIcons                —— 同上，真机稳定出图
//   ❌ 本文件 v6 ——「15 图 × 3 候选错峰竞速 + 看门狗 + wx.loadImage」真机恒为矢量
// 结论：资源、路径、prepSrc 全都不是问题（对战用同一套已跑通），问题只在本文件自己的加载机制：
//   · wx.loadImage 官方文档查无此 API → typeof 判定为 false，该路径 A 在真机从未生效；
//   · 15 图 × 3 候选 = 45 个并发 image 对象，真机解码队列过载/限流，先发的反而被拖死；
//   · 每档 600ms 错峰 → 最坏 1.2s 才轮到 data URI，这期间画面一直是矢量。
// v7 与 spintop 完全同构：一次性建 image → 立即登记 → 单次赋 src → 不重试、不错峰、不看门狗。
// 但 v7 仍有两个真机顽疾（主页/图鉴真机矢量、对战却正常，正是此差异）：
//   ① 主包启动即渲染，首帧 drawBeyblade 在 jsbridge 尚未就绪时发起 wx.createImage+包内路径加载
//      → 真机静默挂起（onload/onerror 均不触发）→ 退而求其次矢量且永不恢复；
//      对战在分包、进入时才加载，故稳定。v8 改为「先等 jsbridge 就绪再发首载」。
//   ② v7 的 6s 兜底把真机加载**换到 data URI**（prepSrc 在真机返回包内路径，兜底却切回 data URI）；
//      而真机 data URI onload 不可靠、早已废弃 —— 这会导致「兜底后仍然矢量」。
//      v8 兜底改为「新 image 对象 + 另一条包内路径斜杠写法」重试一次
//      （绝不重赋同对象 src——真机重复赋 src 静默作废；绝不换 data URI）。
function _mkImg() {
  if (typeof wx !== 'undefined' && wx.createImage) return wx.createImage();
  if (typeof Image !== 'undefined') return new Image();
  return null;
}

// 内嵌 base64 地图：模拟器由 prepSrc 返回 data URI；真机走包内路径（与 spintop 一致）
const _IMGB64 = (function () { try { return require('./imgb64'); } catch (e) { return {}; } })();

// 统一诊断输出：真机排查全靠它
function _log() {
  try {
    if (typeof console === 'undefined' || !console.log) return;
    console.log.apply(console, ['[topimg]'].concat(Array.prototype.slice.call(arguments)));
  } catch (e) {}
}

// 登记并加载一张图：立即登记（未就绪时 width===0，调用方自动回退矢量），单次赋 src。
// 与 battle/spintop.js:153-158 逐行同构——不重试、不错峰、不加前置守卫。
function _startOne(store, key, file, folder) {
  const im = _mkImg();
  if (!im) return null;
  im._ok = false;
  im._file = file;      // 兜底换路时要用
  im._folder = folder;
  im.onload = function () { im._ok = true; _log('ok', folder + '/' + file, im.width); };
  im.onerror = function (e) { _log('fail', folder + '/' + file, (e && e.errMsg) || 'onerror'); };
  // src 由 utils.prepSrc 产出：模拟器 → data URI；真机 → 包内路径 images/<folder>/<file>
  im.src = _prepSrc((_IMGB64[folder] || {})[file], file, folder);
  store[key] = im;
  return im;
}

// 一次性发起全部加载（35 张：5 系 + 5 金 + 5 木 + 5 水 + 5 火 + 5 土 + 5 元素角标）
let _loadStarted = false;
let _t0 = 0;

function _startLoadOnce() {
  const hasApi = (typeof wx !== 'undefined' && wx.createImage) || (typeof Image !== 'undefined');
  if (!hasApi) { _log('no-image-api'); _loadStarted = true; return; }
  for (let i = 0; i < _topFiles.length; i++) _startOne(_topImgs, i, _topFiles[i], 'tops');
  for (let i = 0; i < 5; i++) _startOne(_goldImgs, i, 'gold-lv' + (i + 1) + '.png', 'tops');
  for (let i = 0; i < 5; i++) _startOne(_woodImgs, i, _woodLevelFiles[i], 'tops');
  for (let i = 0; i < 5; i++) _startOne(_waterImgs, i, _waterLevelFiles[i], 'tops');
  for (let i = 0; i < 5; i++) _startOne(_fireImgs, i, _fireLevelFiles[i], 'tops');
  for (let i = 0; i < 5; i++) _startOne(_earthImgs, i, _earthLevelFiles[i], 'tops');
  for (const k in _elFiles) _startOne(_elImgs, k, _elFiles[k], 'icons');
  _loadStarted = true;
}

// 遍历全部已登记的 image
function _eachRec(fn) {
  for (let i = 0; i < _topFiles.length; i++) if (_topImgs[i]) fn(_topImgs[i]);
  for (let i = 0; i < 5; i++) if (_goldImgs[i]) fn(_goldImgs[i]);
  for (let i = 0; i < 5; i++) if (_woodImgs[i]) fn(_woodImgs[i]);
  for (let i = 0; i < 5; i++) if (_waterImgs[i]) fn(_waterImgs[i]);
  for (let i = 0; i < 5; i++) if (_fireImgs[i]) fn(_fireImgs[i]);
  for (let i = 0; i < 5; i++) if (_earthImgs[i]) fn(_earthImgs[i]);
  for (const k in _elFiles) if (_elImgs[k]) fn(_elImgs[k]);
}

// 统一触发加载（渲染期调用；全部就绪后彻底空转，零开销）
// 对齐 spintop 的关键：**只发一次 src**。真机上对同一张图重复/并发发起 image，
// 会让先前的加载静默作废 —— 这正是 v6 越重试越失败的根源。
let _allPngOk = false;
let _fallbackDone = false;
let _lastStateLog = 0;
const _STATE_LOG_WINDOW = 30000;   // 只在前 30s 打状态日志，避免长期刷屏
const _FALLBACK_DELAY = 6000;      // 6s 后仍未全就绪，才对未就绪的图换「新对象 + 另一条包内路径」重试一次

// jsbridge 是否就绪（真机启动早期 getSystemInfoSync 会抛 "jsbridge not ready"）
function _jsbridgeReady() {
  try { return !!(typeof wx !== 'undefined' && wx.getSystemInfoSync && wx.getSystemInfoSync()); }
  catch (e) { return false; }
}

// 把 store 中某张旧 image 换成新 image（兜底重试用新对象，规避「同对象重复赋 src 静默作废」）
function _replaceRec(oldIm, newIm) {
  for (let i = 0; i < _topImgs.length; i++) if (_topImgs[i] === oldIm) { _topImgs[i] = newIm; return; }
  for (let i = 0; i < _goldImgs.length; i++) if (_goldImgs[i] === oldIm) { _goldImgs[i] = newIm; return; }
  for (let i = 0; i < _woodImgs.length; i++) if (_woodImgs[i] === oldIm) { _woodImgs[i] = newIm; return; }
  for (let i = 0; i < _waterImgs.length; i++) if (_waterImgs[i] === oldIm) { _waterImgs[i] = newIm; return; }
  for (let i = 0; i < _fireImgs.length; i++) if (_fireImgs[i] === oldIm) { _fireImgs[i] = newIm; return; }
  for (let i = 0; i < _earthImgs.length; i++) if (_earthImgs[i] === oldIm) { _earthImgs[i] = newIm; return; }
  for (const k in _elImgs) if (_elImgs[k] === oldIm) { _elImgs[k] = newIm; return; }
}

// 选择当前 tier+level 最合适的真实 PNG：金/木/水/火/土优先使用 level 专属贴图；未就绪时回退到该系单图
function _getTierLevelImg(tierIndex, level) {
  const lvIdx = Math.min(level - 1, LEVELS.length - 1);
  if (tierIndex === 0) {
    const im = _earthImgs[lvIdx];
    if (im && im._ok && im.width > 0) return im;
  }
  if (tierIndex === 1) {
    const im = _woodImgs[lvIdx];
    if (im && im._ok && im.width > 0) return im;
  }
  if (tierIndex === 2) {
    const im = _waterImgs[lvIdx];
    if (im && im._ok && im.width > 0) return im;
  }
  if (tierIndex === 3) {
    const im = _fireImgs[lvIdx];
    if (im && im._ok && im.width > 0) return im;
  }
  if (tierIndex === 4) {
    const im = _goldImgs[lvIdx];
    if (im && im._ok && im.width > 0) return im;
  }
  return _topImgs[tierIndex];
}

// ── 源图离屏释放（2026-09-13 内存优化，代码层不碰素材）─────────────────
// 35 张源 wx.Image 解码位图是常驻大头（~1.6MB）。它们只在 getBeybladeSprite 烘焙离屏 sprite
// 时被消费一次；烘焙完成后 sprite（纯栅格化产物）已独立存在、不再引用源图，
// 故源图解码内存可立即释放，仅保留最近 SOURCE_LRU_CAP 张以备重烘焙（避免滚屏/重进页时的重载闪帧）。
// ⚠️ 释放 = 仅置空模块内 store 槽位（丢弃引用交 GC），绝不重赋 src（否则会触发重新加载、
//    且 mock 测试下 src 计数失真、破坏 smoke_topimg_load 的 sets 断言）。
// ⚠️ 元素角标 _elImgs 在渲染期仍被 drawElementBadge 引用（属 35 张契约），体量极小且可能复用，
//    标记为 PINNED 常驻、永不释放。
const SOURCE_LRU_CAP = 8;            // 单屏最多约 10~12 个相异 tier:level sprite，留余量避免重烘焙重载闪帧
const _sourceLive = new Map();       // im → { store, key, lastAccess }：烘焙后登记，离屏释放据此定位槽位

// (tierIndex, level) → 该档源图所在的 store 槽位（与 _getTierLevelImg / _startLoadOnce 同套映射）
function _slotFor(tierIndex, level) {
  const lvIdx = Math.min(level - 1, LEVELS.length - 1);
  if (tierIndex === 0) return { store: _earthImgs, key: lvIdx, file: _earthLevelFiles[lvIdx], folder: 'tops' };
  if (tierIndex === 1) return { store: _woodImgs,  key: lvIdx, file: _woodLevelFiles[lvIdx],  folder: 'tops' };
  if (tierIndex === 2) return { store: _waterImgs, key: lvIdx, file: _waterLevelFiles[lvIdx], folder: 'tops' };
  if (tierIndex === 3) return { store: _fireImgs,  key: lvIdx, file: _fireLevelFiles[lvIdx],  folder: 'tops' };
  if (tierIndex === 4) return { store: _goldImgs,  key: lvIdx, file: 'gold-lv' + (lvIdx + 1) + '.png', folder: 'tops' };
  return { store: _topImgs, key: tierIndex, file: _topFiles[tierIndex], folder: 'tops' };
}

// 释放单个源图槽位（仅弃引用，交给 GC；绝不重赋 src）
function _releaseSlot(store, key) {
  const im = store[key];
  if (!im) return;
  store[key] = null;               // 丢弃模块内引用；平台 GC 回收解码位图
  _sourceLive.delete(im);
}

// 烘焙完成后登记 live，并按 LRU 释放超出上限的源图（保留最近 SOURCE_LRU_CAP 张）
function _sweepSources() {
  if (_sourceLive.size <= SOURCE_LRU_CAP) return;
  const arr = [];
  _sourceLive.forEach(function (rec, im) { if (rec.store[rec.key] === im) arr.push({ im: im, rec: rec }); });
  arr.sort(function (a, b) { return a.rec.lastAccess - b.rec.lastAccess; });
  let drop = arr.length - SOURCE_LRU_CAP;
  for (let i = 0; i < arr.length && drop > 0; i++) {
    _releaseSlot(arr[i].rec.store, arr[i].rec.key);
    drop--;
  }
}


function _ensureAllPngs() {
  if (_allPngOk) return;

  // 1) 等 jsbridge 就绪再发首次加载：对齐 battle/spintop.js「晚加载才稳定出图」的事实。
  //    主页/图鉴在主包、启动即渲染，若启动早期就发起 wx.createImage+包内路径加载，
  //    真机会静默挂起（onload/onerror 均不触发）→ 退而求其次矢量且永不恢复。
  //    对战在分包、进入时才加载，故稳定。这里用 jsbridge 就绪作「稳定时机」信号。
  if (!_loadStarted) {
    if (!_jsbridgeReady()) { _log('wait-jsbridge'); return; }
    _log('boot', 'createImage=' + !!(typeof wx !== 'undefined' && wx.createImage),
      'b64tops=' + Object.keys((_IMGB64 && _IMGB64.tops) || {}).length);
    _loadStarted = true;
    _t0 = Date.now();
    _startLoadOnce();          // 一次性、单次赋 src（与 spintop 逐行同构）
    return;
  }

  // 2) 全部就绪？
  let ready = 0, total = 0;
  _eachRec(function (im) { total++; if (im._ok && im.width > 0) ready++; });

  if (total > 0 && ready === total) {
    _allPngOk = true;
    _log('all-ready', ready + '/' + total, (Date.now() - _t0) + 'ms');
    return;
  }

  // 3) 兜底：仅对仍未就绪的图，用「新 image 对象 + 另一条包内路径写法」重试一次。
  //    · 绝不重赋同一 image 的 src（真机对同一对象重复赋 src 会静默作废，v6 即死于此）；
  //    · 绝不换 data URI（真机 data URI onload 不可靠、已废弃；仅模拟器走 data URI）；
  //    · 真机：当前 images/... 换 /images/...（反之亦然），仍是包内路径 + wx.createImage；
  //    · 模拟器：当前 data URI 再用一次（新对象），devtools 下本就稳定。
  const now = Date.now();
  if (!_fallbackDone && now - _t0 > _FALLBACK_DELAY) {
    _fallbackDone = true;
    let n = 0;
    _eachRec(function (im) {
      if (im._ok && im.width > 0) return;
      let alt = null;
      if (typeof im.src === 'string' && im.src.slice(0, 5) === 'data:') {
        alt = im.src;                                                  // 模拟器：仍走 data URI，但用新对象
      } else {
        alt = im.src.charAt(0) === '/' ? im.src.slice(1) : ('/' + im.src);  // 真机：换斜杠写法
      }
      if (!alt) return;
      const nim = _mkImg();
      if (!nim) return;
      n++;
      nim._ok = false; nim._file = im._file; nim._folder = im._folder;
      nim.onload = function () { nim._ok = true; _log('ok', nim._folder + '/' + nim._file, nim.width); };
      nim.onerror = function (e) { _log('fail', nim._folder + '/' + nim._file, (e && e.errMsg) || 'onerror'); };
      nim.src = alt;                  // 新对象 + 单次赋 src
      _replaceRec(im, nim);
    });
    _log('fallback', n + '/' + total + ' 新对象重试', 'ready=' + ready);
    return;
  }

  // 4) 周期性状态快照：真机上一眼看出卡了几张、卡在哪
  if (_lastStateLog === 0) { _lastStateLog = now; return; }
  if (now - _lastStateLog < 2000) return;
  if (now - _lastStateLog > _STATE_LOG_WINDOW) return;
  _lastStateLog = now;
  const pend = [];
  _eachRec(function (im) { if (!(im._ok && im.width > 0)) pend.push(im._folder + '/' + im._file); });
  _log('pending', ready + '/' + total, pend.slice(0, 6).join(' '));
}
/** 元素角标：彩色圆底 + PNG 图标（未就绪回退文字） */
function drawElementBadge(ctx, el, cx, cy, scale) {
  const r = 9 * scale;
  ctx.fillStyle = el.color;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  let elIm = _elImgs[el.key];
  // 元素角标同样走渲染期懒加载（与陀螺同机制），保证真机首次绘制时触发加载
  if (!(elIm && elIm._ok && elIm.width > 0)) { _ensureAllPngs(); elIm = _elImgs[el.key]; }
  if (elIm && elIm._ok && elIm.width > 0) {
    const s = 12 * scale;
    ctx.drawImage(elIm, cx - s / 2, cy - s / 2, s, s);
    return;
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold ' + Math.floor(11 * scale) + 'px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(el.name, cx, cy);
}

// 五灵神兽（五方）：麒麟(中·土) → 青龙(东·木) → 玄武(北·水) → 朱雀(南·火) → 白虎(西·金)
// 2026-09-13 改名：原「土·普通 / 木·稀有 / 水·史诗 / 火·精英 / 金·传说」——
//   陀螺名里塞稀有度词不搭（"太普通了/稀有了"），统一换成五灵神兽名。
//   ⚠️ 只改 name；key / color / glow / chance 与数组顺序（0→4 由弱到强）一律不动，兜底/保底/图鉴索引都依赖顺序。
//   ⚠️ 这里是【陀螺名 / 品质档名】；元素名是另一套（金/木/水/火/土 单字，见 ELEMENTS），两套名字不许重名。
//   ⚠️ 元素是**另一套独立轴**（金/木/水/火/土，见 ELEMENTS），与品质名（五灵神兽）不许重名；
//      元素取值见构造函数公式，不随品质恒定（方案A：25 种「神兽×元素」组合）。
const TIERS = [
  { key: 'earth',   name: '麒麟', color: '#a1887f', glow: '#bcaaa4', chance: 0.40 },
  { key: 'wood',    name: '青龙', color: '#66bb6a', glow: '#81c784', chance: 0.28 },
  { key: 'water',   name: '玄武', color: '#42a5f5', glow: '#64b5f6', chance: 0.18 },
  { key: 'fire',    name: '朱雀', color: '#ef5350', glow: '#ef9a9a', chance: 0.10 },
  { key: 'metal',   name: '白虎', color: '#ffd54f', glow: '#fff59d', chance: 0.04 }
];

const LEVELS = [
  { level: 1, power: 10,  radius: 28, spinSpeed: 2.5 },
  { level: 2, power: 25,  radius: 32, spinSpeed: 3.0 },
  { level: 3, power: 55,  radius: 36, spinSpeed: 3.6 },
  { level: 4, power: 120, radius: 42, spinSpeed: 4.3 },
  { level: 5, power: 280, radius: 48, spinSpeed: 5.2 }
];

// 五行元素（属性轴）：金(0)→木(1)→水(2)→火(3)→土(4)
// ⚠️ 元素名【刻意只用「金/木/水/火/土」单字，不与陀螺名（五灵神兽）共用】——
//   陀螺名（TIERS[].name = 麒麟/青龙/玄武/朱雀/白虎）是**品质档名**，元素是**每只陀螺各自的属性**，
//   两者是独立的两个轴：一个玄武陀螺的元素可以是火。
//   若两边同名，UI 会读成「玄武 Lv3 · 元素·朱雀」这种自相矛盾（且「白虎」是最高档神兽名，
//   出现在低档陀螺的属性上更像 bug）。分开命名后读作「玄武 Lv3 · 元素·火」＝ 品质 + 属性，语义独立。
//   （2026-09-13 修：上一轮改名误把元素名也换成神兽名，用户在选陀螺面板看到「玄武 · 元素·白虎」后报 bug → 回退单字。）
// 元素取值（方案A·2026-09-13 回退）：一只陀螺的元素 = f(品质, 等级)，由下方构造函数公式算得，
//   **不随品质恒定、也不与品质同名**。同档 5 个等级恰好各占一个元素（25 种「神兽×元素」组合），
//   所以「麒麟 Lv2」=火麒麟、「麒麟 Lv5」=水麒麟 —— 升级过程天然产出不同元素的同神兽，
//   既撑起收集/升级深度，也撑起 25 款皮肤的差异化生产。羁绊「同元素 ≥3」是跨品质的真收集目标。
//   ⚠️ beats 索引与倍率（1.35 / 0.75 / 1）一分未动 —— 只改 elementIdx 的取值来源。
const ELEMENTS = [
  { key: 'metal', name: '金', color: '#ffd54f', beats: 1 },
  { key: 'wood',  name: '木', color: '#66bb6a', beats: 4 },
  { key: 'water', name: '水', color: '#42a5f5', beats: 3 },
  { key: 'fire',  name: '火', color: '#ef5350', beats: 0 },
  { key: 'earth', name: '土', color: '#a1887f', beats: 2 }
];

// =====================================================
// P0-3 词条系统（2026-10-31）：金币洗词条 = 金币回流战斗的硬出口
// 每条词条映射为战斗内一个既有参数的加成（见 spintop._applyTraits 的映射表）。
// 规则：
//   - 新陀螺天生 1 条随机词条；合成产物继承父母词条并集（去重、封顶 2 条）→
//     「合成提词条数」给合成额外一个长期目标；
//   - 老存档加载时补 1 条（见 game.load），全量玩家即时可用；
//   - 「洗词条」花金币把现有词条重掷为同等数量的新随机词条（价格递增，见 config.trait）。
// ⚠️ 词条只作用于玩家方（敌方不吃）；改加成数值要同步 spintop._applyTraits 与本表 desc。
// =====================================================
const TRAITS = [
  { id: 'crit',   name: '暴击强化', desc: '暴击伤害 +15%',   color: '#ff5252' },
  { id: 'combo',  name: '连击延展', desc: '连击窗口 +0.3s',  color: '#42a5f5' },
  { id: 'rage',   name: '开局怒气', desc: '开局怒气 +25',    color: '#ffb300' },
  { id: 'stable', name: '稳固底盘', desc: '出界线外扩 5%',   color: '#a1887f' },
  { id: 'score',  name: '得分专精', desc: '得分 +8%',        color: '#ffd54f' },
  { id: 'whip',   name: '强力抽打', desc: '抽打力度 +5%',    color: '#ef5350' },
  { id: 'surge',  name: '怒气回涌', desc: '命中额外怒气 +2', color: '#b388ff' }
];

const TRAIT_MAX = 2;   // 单只陀螺词条上限（与 config.trait.maxTraits 一致，这里作兜底真源）

/** 随机词条：count 条、id 互不重复。count 非法/超出池子大小时自动钳制。 */
function rollTraits(count) {
  let n = Math.max(0, Math.min(TRAITS.length, Math.floor(count || 0)));
  const pool = TRAITS.slice();
  const out = [];
  while (n > 0 && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    const t = pool.splice(i, 1)[0];
    out.push({ id: t.id });
    n--;
  }
  return out;
}

/** 按 id 找词条定义（非法 id 返回 null，渲染/存档清洗用） */
function traitById(id) {
  for (let i = 0; i < TRAITS.length; i++) if (TRAITS[i].id === id) return TRAITS[i];
  return null;
}

/** a 对 b 的克制倍率：a 克 b=1.35，a 被 b 克=0.75，无克制=1 */
function elementMultiplier(aIdx, bIdx) {
  if (ELEMENTS[aIdx].beats === bIdx) return 1.35;
  if (ELEMENTS[bIdx].beats === aIdx) return 0.75;
  return 1;
}

/**
 * 品质档 → 元素索引（方案B：元素绑定品质，恒定）。
 * 按 key 匹配而非按下标 —— 两个数组顺序是巧合（金木水火土 vs 土金木水火），
 * 写死下标日后调顺序会静默错位，按 key 匹配则改顺序自动跟随。
 */
/** b 被哪个元素克制（返回元素索引，无则 -1）——UI 展示「被 X 克」用 */
function elementBeatenBy(aIdx) {
  for (let i = 0; i < ELEMENTS.length; i++) if (ELEMENTS[i].beats === aIdx) return i;
  return -1;
}

class Beyblade {
  constructor(tierIndex = 0, level = 1) {
    this.tierIndex = tierIndex;
    this.level = level;
    this.angle = Math.random() * Math.PI * 2;
    this.spinSpeed = LEVELS[Math.min(level - 1, LEVELS.length - 1)].spinSpeed;
    this.radius = LEVELS[Math.min(level - 1, LEVELS.length - 1)].radius;
    this.power = this.calcPower();
    this.id = Date.now() + Math.random().toString(36).slice(2, 8);
    // 方案A（2026-09-13 回退）：元素 = f(品质, 等级) = (tierIndex * 7 + (level % 5) * 3) % 5。
    // 同档 5 个等级各占一个元素，25 种「神兽×元素」组合；元素名是金木水火土，与品质名（神兽）零重名，不读成 bug。
    this.elementIdx = (tierIndex * 7 + (level % 5) * 3) % 5;
    // P0-3 词条：默认空数组。词条在【获取点】分配（game.js 的抽卡/宝箱/签到/合成/老档迁移），
    // 而不是构造器里随机 —— 因为敌方陀螺与战斗模拟都直接 new Beyblade：
    // 构造器随机会让敌方吃上无意义词条、且让所有数值型冒烟测试变得不可复现。
    this.traits = [];
  }

  get tier() {
    return TIERS[this.tierIndex];
  }

  get elementInfo() {
    return ELEMENTS[this.elementIdx];
  }

  calcPower() {
    const base = LEVELS[Math.min(this.level - 1, LEVELS.length - 1)].power;
    const tierMultiplier = 1 + this.tierIndex * 0.5;
    return Math.floor(base * tierMultiplier);
  }

  clone() {
    const c = new Beyblade(this.tierIndex, this.level);
    // P0-3：克隆必须携带词条与洗词条次数 —— 战斗用的是 playerBb.clone()，
    // 若丢词条，玩家选好的「暴击强化」在战斗里会被换成一只随机词条（既失真又不可复现）。
    c.traits = (Array.isArray(this.traits) ? this.traits.map(t => ({ id: t.id })) : []);
    c.rerolls = this.rerolls || 0;
    return c;
  }

  canMergeWith(other) {
    return this.tierIndex === other.tierIndex && this.level === other.level && this.level < 5;
  }

  merge() {
    if (this.level >= 5) return this;
    const next = new Beyblade(this.tierIndex, this.level + 1);
    // P0-3 词条继承：产物 = 父母词条并集（去重、封顶 2 条）。父母词条相同时并集即 1 条，
    // 不再额外补抽 —— 「凑两只词条不同的同类合成」成为可追求的合成目标。
    if (typeof arguments[0] !== 'undefined') {
      // 新签名 merge(other)：并集继承。旧签名 merge()（无参）保持原行为（产物只带天生 1 条）。
      const other = arguments[0];
      const seen = {};
      const out = [];
      const add = (t) => {
        if (t && t.id && !seen[t.id] && out.length < TRAIT_MAX) { seen[t.id] = 1; out.push({ id: t.id }); }
      };
      (Array.isArray(this.traits) ? this.traits : []).forEach(add);
      (other && Array.isArray(other.traits) ? other.traits : []).forEach(add);
      next.traits = out.length ? out : rollTraits(1);
    }
    return next;
  }

  update(dt) {
    this.angle += this.spinSpeed * dt * 2;
  }
}

function randomBeyblade(luck = 1) {
  let r = Math.random();
  // luck 越大 → 越偏向高稀有度区间；luck=1 行为不变（当前调用点均默认 1，无实际影响）
  if (luck !== 1) r = 1 - Math.pow(1 - r, luck);
  let acc = 0;
  for (let i = 0; i < TIERS.length; i++) {
    acc += TIERS[i].chance;
    if (r <= acc) return new Beyblade(i, 1);
  }
  return new Beyblade(TIERS.length - 1, 1);
}

/**
 * 光晕径向渐变缓存：createRadialGradient 是相对昂贵的分配，每帧每个陀螺调用一次。
 * 渐变坐标绑定在相对中心 (0,0)，fill 时随 translate 生效，同一对象可跨帧/跨陀螺复用。
 * 键 = 品质辉光色 + 半径（半径档位离散，缓存条目有限，无泄漏风险）。
 */
const _glowCache = {};
function glowGradient(ctx, color, r) {
  const key = color + '|' + Math.round(r * 100);
  let g = _glowCache[key];
  if (!g) {
    g = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.6);
    g.addColorStop(0, color + '44');
    g.addColorStop(1, color + '00');
    _glowCache[key] = g;
  }
  return g;
}

/**
 * 绘制单个陀螺
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {Beyblade} bb
 * @param {number} scale
 */
/**
 * 陀螺精灵离屏预渲染：把与角度无关的静态层 + 叶片(角度0) + 等级数字(角度0)
 * 一次性烘焙到一张离屏画布，之后每帧只需 drawImage + rotate(angle) 即可"自转"。
 * 这是 DrawCall / 每帧重绘开销的最大单项优化（背包/图鉴/合成台每帧数十个陀螺）。
 * 缓存键仅 tierIndex:level（4×5=20 种，内存有界、无泄漏）。
 * LRU淘汰：缓存上限60个，超过时淘汰最久未使用的sprite，避免长期运行后内存泄漏。
 */
const _spriteCache = {};
// 内存杠杆（云测 P1·内存峰值 60 分，2026-10-31）：LRU 60 → 32。
// 图鉴单屏最多 25 个相异 tier:level sprite，32 仍足覆盖；LRU 淘汰保证超上限自动回收，
// 常驻离屏画布内存约 -2MB，低内存设备（4G）OOM 余量更大。
const SPRITE_CACHE_MAX = 32;
let _sprDiagN = 0;           // 真机排障：前 12 次 sprite 烘焙打印 enter 分支，看烘焙前图片是否已就绪
let _sprDiagFirstPng = false; // 真机排障：PNG 首次就绪的第一次烘焙（分水岭）强制打印一次
let _sprDiagFail = false;     // 真机排障：离屏画布创建失败只打印一次，避免刷屏
// ── 离屏画布可用性探测（2026-09-02 内存/性能优化）────────────────────────────
// 原实现是 **永久闭锁**：离屏画布首次创建失败就置一个模块级布尔量，此后整个会话
// 再也不重试（drawBeyblade 永远走「直接画 PNG」兜底，60 项 sprite LRU 缓存白建）。
//
// 为什么这是 bug：本项目已反复实证「真机启动瞬间 jsbridge 未就绪，wx.* 调用会静默失败」
// （图片加载 v8 修复记录、prepSrc 的 try/catch 都是同一类问题）。离屏画布创建极可能只是
// **首帧时序性失败**，却被永久闭锁 —— 且旧注释写的「下次调用重新尝试」与先判该布尔量、
// 直接返回 fail 的代码**自相矛盾**。
//
// 现改为「指数退避 + 冷却重探」：失败后短暂禁用（2s→4s→8s…上限 60s），冷却结束允许重探；
// 一旦成功立即清零计数。既不会每帧重试浪费，也不会因一次时序抖动永久退化。
const OFFSCREEN_BACKOFF_BASE_MS = 2000;
const OFFSCREEN_BACKOFF_CAP_MS = 60000;
let _offFailN = 0;    // 连续失败次数（成功即清零）
let _offFailAt = 0;   // 上次失败时间戳

// 当前应禁用离屏？now 可注入，便于测试用可控时钟。
function offscreenDisabled(now) {
  if (_offFailN <= 0) return false;
  const t = (typeof now === 'number') ? now : Date.now();
  const backoff = Math.min(OFFSCREEN_BACKOFF_BASE_MS * Math.pow(2, _offFailN - 1), OFFSCREEN_BACKOFF_CAP_MS);
  return (t - _offFailAt) < backoff;
}

function _offscreenOnFail(now) {
  _offFailN++;
  _offFailAt = (typeof now === 'number') ? now : Date.now();
}

function _offscreenOnOk() { _offFailN = 0; _offFailAt = 0; }
let _dbgDirectDone = false;
function _dbgDirectOnce() { if (_dbgDirectDone) return; _dbgDirectDone = true; _log('directdraw', 'engaged（离屏不可用→直接画 PNG 到主画布）'); }
function getBeybladeSprite(tierIndex, level) {
  // key 附加 PNG 就绪态：PNG 加载完成前烘焙的矢量缓存，在 PNG 就绪后自动重烘焙，
  // 避免真机（代码包加载慢）首帧用矢量烘焙后就永久显示矢量 —— 与 spintop _ensureTopSprite 同款机制。
  // 未就绪则节流重试加载一次——覆盖「真机启动时 wx 尚未就绪导致首轮加载全失败」的场景。
  const lvIdx0 = Math.min(level - 1, LEVELS.length - 1);
  const probe = _getTierLevelImg(tierIndex, level);
  if (!(probe && probe._ok && probe.width > 0)) _ensureAllPngs();

  const lvIdx = Math.min(level - 1, LEVELS.length - 1);
  const topImg = _getTierLevelImg(tierIndex, level);
  const pngOk = !!(topImg && topImg._ok && topImg.width > 0);
  const key = tierIndex + ':' + level + '|' + (pngOk ? 'png' : 'vec');
  // 真机排障诊断：① 前 12 次调用打印 enter（含 pngOk，看烘焙前图片是否已就绪）；
  // ② PNG 首次就绪的第一次烘焙强制打印一次（这是「加载完成→是否真的用 PNG 烘焙」的分水岭，不受次数限制）。
  if (_sprDiagN < 12) { _sprDiagN++; _log('spr', 'enter', 'tier=' + tierIndex, 'lv=' + level, 'pngOk=' + pngOk, 'key=' + key); }
  if (pngOk && !_sprDiagFirstPng) { _sprDiagFirstPng = true; _log('spr', 'PNG_READY_FIRST', 'tier=' + tierIndex, 'lv=' + level, 'key=' + key); }
  const cached = _spriteCache[key];
  if (cached) {
    cached._lastAccess = Date.now(); // LRU：更新最后访问时间
    if (_sprDiagN <= 12) _log('spr', 'hit', 'tier=' + tierIndex, 'lv=' + level, 'key=' + key, 'fail=' + (!!cached.fail));
    return cached;
  }
  // ── 源图离屏释放后重烘焙：本帧缓存未命中且源图已被释放（槽位为空）→ 懒重载单图。
  // 仅当启动全量预载已结束后才走此路径；若槽位仍注册（boot/兜底在管）则不重复发 src。
  // 重载会重新打开全局 6s 兜底观察（_allPngOk=false），真机静默挂起时由既有的换路兜底覆盖。
  if (!pngOk && _loadStarted) {
    const slot = _slotFor(tierIndex, level);
    if (!slot.store[slot.key]) {
      _startOne(slot.store, slot.key, slot.file, slot.folder);
      _allPngOk = false;
    }
  }
  const R = LEVELS[Math.min(level - 1, LEVELS.length - 1)].radius;
  // sprite尺寸与对战 _ensureTopSprite 一致：基于 R*2 计算（只包含陀螺本体），不包含光晕外沿
  // 避免sprite尺寸过大导致drawBeyblade绘制时只显示中心部分，陀螺不完整
  const pad = 4;
  // 4px 对齐：与 spintop.js _ensureTopSprite 一致，兼容部分机型 drawImage 偶数尺寸限制，
  // 避免奇数尺寸位图在自转 drawImage 时图形撕裂/错位（对战/收获/背包陀螺都会走这里）。
  const S = Math.ceil((R * 2 + pad * 2) / 4) * 4;
  const half = S / 2;
  let cv = null;
  try {
    if (typeof wx !== 'undefined' && wx.createOffscreenCanvas) {
      cv = wx.createOffscreenCanvas({ width: S, height: S });
    } else if (typeof document !== 'undefined' && document.createElement) {
      cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
    }
  } catch (e) { cv = null; }
  // 离屏画布创建失败时不缓存失败状态（与对战 _ensureTopSprite 一致），下次调用重新尝试
  // 避免真机上首次创建失败后永久走矢量回退路径，导致PNG陀螺渲染不出来
  if (!cv || !cv.getContext) { if (!_sprDiagFail) { _sprDiagFail = true; _log('spr', 'FAIL', 'tier=' + tierIndex, 'lv=' + level, 'reason=offscreen', 'pngOk=' + pngOk); } _offscreenOnFail(); return { fail: true }; }
  const c = cv.getContext('2d');
  if (!c) { if (!_sprDiagFail) { _sprDiagFail = true; _log('spr', 'FAIL', 'tier=' + tierIndex, 'lv=' + level, 'reason=getContext', 'pngOk=' + pngOk); } _offscreenOnFail(); return { fail: true }; }
  // 离屏可用 → 清零退避计数（此前若因首帧 jsbridge 未就绪失败过，此处自动恢复烘焙）
  _offscreenOnOk();
  // 关键：离屏画布在部分微信版本/机型上初始化为「不透明白底」而非透明，若不清空，
  // 陀螺 PNG 只覆盖中心圆盘，四角会露出白方块（用户实机反馈的「大方块白底」）。先清成透明。
  c.clearRect(0, 0, S, S);
  c.translate(half, half);
  // 等级光环已去除：随着陀螺旋转时虚线圆环不好看，等级通过中央数字标识即可
  // 本体：真实品质 PNG（未就绪时回退矢量）
  // topImg 已在上方根据 tier/level 选定（金系/木系/水系优先使用 level 专属贴图）
  if (topImg && topImg._ok && topImg.width > 0) {
    const tgt = R * 2.05;   // PNG 主体直径 ≈ 外环直径 2R（与对战 _ensureTopSprite 完全一致：不裁切）
    // 重要：原先在此用 c.clip() 圆形遮罩裁切 PNG；但真机上「clip + drawImage(wx.Image) 进离屏画布」
    // 偶发合成空白/静默失败（对战页 _ensureTopSprite 从不做 clip 却稳定出图，印证此差异）。
    // 故对齐对战：直接整图绘制、不裁切。PNG 本体本身已是透明底陀螺，无需裁切角标。
    c.drawImage(topImg, -tgt / 2, -tgt / 2, tgt, tgt);
    // 源图烘焙完成 → 登记 live + 离屏释放（LRU）：源解码内存不再被显示引用，可释放
    const _bslot = _slotFor(tierIndex, level);
    if (_bslot.store[_bslot.key] === topImg) {
      _sourceLive.set(topImg, { store: _bslot.store, key: _bslot.key, lastAccess: Date.now() });
      _sweepSources();
    }
  } else {
    // 原矢量本体：外环 + 旋转装饰（6 光点）
    c.strokeStyle = TIERS[tierIndex].color; c.lineWidth = 4;
    c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.stroke();
    c.fillStyle = TIERS[tierIndex].color + 'cc';
    for (let i = 0; i < 6; i++) {
      c.save();
      c.rotate((i / 6) * Math.PI * 2);
      c.beginPath();
      c.arc(0.55 * R, 0, 0.14 * R, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }
  // 等级数字（角度0，加深色描边保证在 PNG 上也清晰）
  c.fillStyle = '#ffffff';
  c.font = 'bold ' + Math.floor(R * 0.5) + 'px sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.strokeStyle = 'rgba(12,6,28,0.8)'; c.lineWidth = 3;
  c.strokeText(String(level), 0, 0);
  c.fillText(String(level), 0, 0);
  const entry = { canvas: cv, size: S, fail: false, _lastAccess: Date.now() };
  // LRU淘汰：缓存数量超过上限时，淘汰最久未使用的sprite
  const cacheKeys = Object.keys(_spriteCache);
  if (cacheKeys.length >= SPRITE_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const k of cacheKeys) {
      const t = _spriteCache[k]._lastAccess || 0;
      if (t < oldestTime) {
        oldestTime = t;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      // 释放离屏画布资源（部分平台需要手动释放）
      const old = _spriteCache[oldestKey];
      if (old && old.canvas && typeof old.canvas.width === 'number') {
        old.canvas.width = 0; old.canvas.height = 0;
      }
      delete _spriteCache[oldestKey];
    }
  }
  if (_sprDiagN <= 12) _log('spr', 'bake', 'tier=' + tierIndex, 'lv=' + level, 'pngOk=' + pngOk, 'key=' + key, 'offOk=' + (!!(cv && cv.getContext && cv.getContext('2d'))), 'fail=' + (!!entry.fail));
  _spriteCache[key] = entry;
  // PNG 就绪烘焙完成 → 同档位的旧矢量 sprite（|vec）已永远不会再被请求，立即清掉，
  // 避免 vec/png 两套 key 双占 sprite 缓存（图鉴 25 档冷启动后最多 50 张死重、直到 LRU 满 60 才淘汰，
  // 恰好拖着 0.5~1.4MB 的 iOS 瞬态/半常驻尖峰）。矢量仍是 PNG 未就绪时的安全兜底，不删。
  if (pngOk) {
    const _vecKey = tierIndex + ':' + level + '|vec';
    const _oldVec = _spriteCache[_vecKey];
    if (_oldVec) {
      if (_oldVec.canvas && typeof _oldVec.canvas.width === 'number') { _oldVec.canvas.width = 0; _oldVec.canvas.height = 0; }
      delete _spriteCache[_vecKey];
    }
  }
  return entry;
}

/**
 * 内存告警时清空陀螺 sprite 离屏缓存（低端机防 OOM 被系统 kill）。
 *
 * 释放方式照搬上方 LRU 淘汰（canvas.width=0 / height=0）：部分平台离屏画布需手动释放。
 * 为什么安全：sprite 是**纯本地烘焙产物**（离屏 canvas 上绘制），清掉后下次 drawBeyblade
 * 会按需重新烘焙，不涉及网络/包内资源加载，不存在真机图片「静默挂起」风险
 * （对比 _homeBgImage 这类已加载的 image 对象则绝不能清 —— 真机重载有挂起顽疾）。
 *
 * @returns {number} 释放的 sprite 数量
 */
function clearSpriteCache() {
  let n = 0;
  try {
    for (const k in _spriteCache) {
      const e = _spriteCache[k];
      try {
        if (e && e.canvas && typeof e.canvas.width === 'number') {
          e.canvas.width = 0; e.canvas.height = 0;
        }
      } catch (err) {}
      delete _spriteCache[k];
      n++;
    }
  } catch (e) {}
  // 内存告警时同步释放非 PINNED 的源图解码内存（sprite 已清，重烘焙会按需懒重载）
  _sourceLive.forEach(function (rec, im) { _releaseSlot(rec.store, rec.key); });
  _sourceLive.clear();
  return n;
}

/**
 * 原始矢量绘制（精灵不可用时的回退路径，逻辑与原实现一致）
 * 支持 uniformSize 参数：所有等级陀螺绘制尺寸一致（按最大等级5级的radius基准）
 */
function drawBeybladeVector(ctx, x, y, bb, scale, opts = {}) {
  // uniformSize：所有等级陀螺半径一致（按最大等级5级的radius基准）
  // 用于图鉴/背包/合成台等展示场景，避免高等级陀螺超出容器
  let baseR = bb.radius;
  if (opts.uniformSize) {
    baseR = LEVELS[LEVELS.length - 1].radius;
  }
  const r = baseR * scale;
  const tier = bb.tier;
  const a = bb.angle;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = glowGradient(ctx, tier.glow, r);
  ctx.beginPath(); ctx.arc(0, 0, r * 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = tier.color; ctx.lineWidth = 4 * scale;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  if (bb.level >= 2) {
    const lv = Math.min(bb.level, 5);
    ctx.strokeStyle = 'rgba(255,213,79,' + (0.35 + lv * 0.11) + ')';
    ctx.lineWidth = 3 * scale; ctx.setLineDash([lv * 1.6, 3 + lv]);
    ctx.beginPath(); ctx.arc(0, 0, r + 6 * scale, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  }
  // 元素角标已移至外部 render.js 叠加显示（背包cell/合成台槽位右上角）——此处不再取 ELEMENTS[...]（取值无人使用）
  ctx.rotate(a);
  // 旋转装饰：6 个正圆光点环绕中心。圆形是旋转对称的——任意转速下视觉稳定，
  // 绝不会像菱形块（旧直线菱形/扁椭圆叶片旋转时轮廓变化 → 像翻转的棱形）。
  ctx.fillStyle = tier.color + 'cc';
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.rotate((i / 6) * Math.PI * 2);
    ctx.beginPath();
    ctx.arc(0.55 * r, 0, 0.14 * r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.rotate(-a);
  ctx.fillStyle = '#ffe082'; ctx.beginPath(); ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ff8f00'; ctx.lineWidth = 2 * scale; ctx.stroke();
  ctx.fillStyle = tier.color; ctx.beginPath(); ctx.arc(0, 0, r * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(a);
  // 等级数字（中央，与 PNG sprite 一致）
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold ' + Math.floor(r * 0.5) + 'px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(12,6,28,0.8)'; ctx.lineWidth = 3;
  ctx.strokeText(String(bb.level), 0, 0);
  ctx.fillText(String(bb.level), 0, 0);
  ctx.restore();
}

/**
 * 绘制单个陀螺（带离屏精灵缓存）
 * 精灵按 tierIndex:level 烘焙一次；绘制时按 scale 缩放并 rotate(angle) 实现自转。
 * 元素角标不随旋转（固定右上），故单独绘制，保证可读性。
 */
function drawBeyblade(ctx, x, y, bb, scale = 1, opts = {}) {
  const r = bb.radius * scale;
  const a = bb.angle;
  // 离屏不可用时走「直接画 PNG」兜底（与对战页最终 drawImage 到主画布同一原语，稳定可靠），
  // 绝不退回矢量。禁用是**带冷却的临时状态**（2s→4s→8s…上限 60s），冷却结束自动重探，
  // 不再像旧实现那样因首帧时序失败就永久退化。
  const spr = offscreenDisabled() ? { fail: true } : getBeybladeSprite(bb.tierIndex, bb.level);
  // 绘制大小按 radius * 2 计算（和对战页面一致）；uniformSize 时按最大等级 radius 基准；maxSize 限幅
  let baseR = bb.radius;
  if (opts.uniformSize) {
    baseR = LEVELS[LEVELS.length - 1].radius;
  }
  let drawS = baseR * 2 * scale;
  if (opts.maxSize && drawS > opts.maxSize) {
    drawS = opts.maxSize;
  }

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);

  if (spr.fail) {
    // 兜底：真实 PNG 直接画到主画布（与对战页最终 drawImage 到主画布是同一原语，稳定可靠）
    const topImg = _getTierLevelImg(bb.tierIndex, bb.level);
    if (topImg && topImg._ok && topImg.width > 0) {
      try {
        ctx.drawImage(topImg, -drawS / 2, -drawS / 2, drawS, drawS);
        _dbgDirectOnce();
      } catch (e) {
        ctx.restore();
        drawBeybladeVector(ctx, x, y, bb, scale, opts);
        return;
      }
    } else {
      ctx.restore();
      drawBeybladeVector(ctx, x, y, bb, scale, opts);
      return;
    }
  } else {
    try {
      ctx.drawImage(spr.canvas, -drawS / 2, -drawS / 2, drawS, drawS);
    } catch (e) {
      ctx.restore();
      drawBeybladeVector(ctx, x, y, bb, scale, opts);
      return;
    }
  }

  // 等级数字（中央，叠加在 PNG 上，加深色描边保证在 PNG 上也清晰）
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold ' + Math.floor(drawS * 0.25) + 'px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(12,6,28,0.8)'; ctx.lineWidth = 3 * scale;
  ctx.strokeText(String(bb.level), 0, 0);
  ctx.fillText(String(bb.level), 0, 0);
  ctx.restore();
}

module.exports = {
  Beyblade,
  TIERS,
  LEVELS,
  ELEMENTS,
  elementMultiplier,
  elementBeatenBy,
  randomBeyblade,
  drawBeyblade,
  // P0-3 词条系统
  TRAITS,
  rollTraits,
  traitById,
  // 内存告警时释放 sprite 离屏缓存（低端机防 OOM 闪退，见 .workbuddy 记忆 2026-09-01）
  clearSpriteCache,
  // 对战页接入等级专属贴图：暴露等级专属图选择器（与内部 _getTierLevelImg 同语义）
  getTierLevelImg: _getTierLevelImg,
  // 离屏画布可用性探测（2026-09-02：永久闭锁 → 指数退避重探）。
  // 导出三个状态函数仅供测试注入可控时钟；业务代码请勿直接调用 _offscreenOnFail/_offscreenOnOk。
  offscreenDisabled,
  _offscreenOnFail,
  _offscreenOnOk
};
