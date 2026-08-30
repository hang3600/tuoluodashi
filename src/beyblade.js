/**
 * 陀螺数据与绘制
 */

// 真实陀螺 PNG 数字资产（五行系统）：土→木→水→火→金，金是传说级
const _topFiles = ['top-earth.png', 'top-wood.png', 'top-water.png', 'top-fire.png', 'top-metal.png'];
const _topImgs = [];

// 元素角标真实 PNG（五行系统）：金/木/水/火/土
const _elFiles = { metal: 'icon-metal.png', wood: 'icon-wood.png', water: 'icon-water.png', fire: 'icon-fire.png', earth: 'icon-earth.png' };
const _elImgs = {};

// 真实资产已全部外置为包内 PNG 文件（images/tops、images/icons），
// prepSrc(b64=null, file, folder) 在 b64 为空时自动回退到 /images/<folder>/<file> 路径加载。
const _TOP_B64 = (function () { try { return require('./assets').tops; } catch (e) { return null; } })();

// 真机 PNG 加载加固：dataURI 在真机 onload 不可靠 → 改用 utils.prepSrc/loadOne（bake 到 USER_DATA_PATH 文件再加载）
const { prepSrc: _prepSrc, loadOne: _loadOne } = require('./utils');

(function loadTopPNGs() {
  try {
    if (!_TOP_B64) return; // 无 base64 → 全程矢量回退（与旧逻辑一致）
    for (let i = 0; i < _topFiles.length; i++) {
      const src = _prepSrc(_TOP_B64[i], _topFiles[i], 'tops');
      _loadOne(src, (function (idx) {
        return function (err, im) { if (!err && im) _topImgs[idx] = im; };
      })(i));
    }
  } catch (e) { /* 失败 → 全程矢量回退 */ }
})();

(function loadElPNGs() {
  try {
    // els 已外置为 images/icons/icon-<el>.png，按 _elFiles 文件名从包路径加载
    for (const k in _elFiles) {
      const src = _prepSrc(null, _elFiles[k], 'icons');
      _loadOne(src, (function (key) {
        return function (err, im) { if (!err && im) _elImgs[key] = im; };
      })(k));
    }
  } catch (e) { /* 失败 → 角标文字回退 */ }
})();
/** 元素角标：彩色圆底 + PNG 图标（未就绪回退文字） */
function drawElementBadge(ctx, el, cx, cy, scale) {
  const r = 9 * scale;
  ctx.fillStyle = el.color;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  const elIm = _elImgs[el.key];
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

// 五行品质：土(普通)→木(稀有)→水(史诗)→火(史诗+)→金(传说)
const TIERS = [
  { key: 'earth',   name: '土·普通', color: '#a1887f', glow: '#bcaaa4', chance: 0.40 },
  { key: 'wood',    name: '木·稀有', color: '#66bb6a', glow: '#81c784', chance: 0.28 },
  { key: 'water',   name: '水·史诗', color: '#42a5f5', glow: '#64b5f6', chance: 0.18 },
  { key: 'fire',    name: '火·精英', color: '#ef5350', glow: '#ef9a9a', chance: 0.10 },
  { key: 'metal',   name: '金·传说', color: '#ffd54f', glow: '#fff59d', chance: 0.04 }
];

const LEVELS = [
  { level: 1, power: 10,  radius: 28, spinSpeed: 2.5 },
  { level: 2, power: 25,  radius: 32, spinSpeed: 3.0 },
  { level: 3, power: 55,  radius: 36, spinSpeed: 3.6 },
  { level: 4, power: 120, radius: 42, spinSpeed: 4.3 },
  { level: 5, power: 280, radius: 48, spinSpeed: 5.2 }
];

// 五行元素：金(0)→木(1)→水(2)→火(3)→土(4)
// 五行相克：金克木、木克土、土克水、水克火、火克金
const ELEMENTS = [
  { key: 'metal', name: '金', color: '#ffd54f', beats: 1 },
  { key: 'wood',  name: '木', color: '#66bb6a', beats: 4 },
  { key: 'water', name: '水', color: '#42a5f5', beats: 3 },
  { key: 'fire',  name: '火', color: '#ef5350', beats: 0 },
  { key: 'earth', name: '土', color: '#a1887f', beats: 2 }
];

/** a 对 b 的克制倍率：a 克 b=1.35，a 被 b 克=0.75，无克制=1 */
function elementMultiplier(aIdx, bIdx) {
  if (ELEMENTS[aIdx].beats === bIdx) return 1.35;
  if (ELEMENTS[bIdx].beats === aIdx) return 0.75;
  return 1;
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
    // 元素由 品质×等级 确定性派生，保证合成/图鉴/存档一致（五行5元素）
    this.elementIdx = (tierIndex * 7 + (level % 5) * 3) % 5;
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
    return new Beyblade(this.tierIndex, this.level);
  }

  canMergeWith(other) {
    return this.tierIndex === other.tierIndex && this.level === other.level && this.level < 5;
  }

  merge() {
    if (this.level >= 5) return this;
    const next = new Beyblade(this.tierIndex, this.level + 1);
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
const SPRITE_CACHE_MAX = 60; // 5品质*5等级*2状态=50，留10个余量
function getBeybladeSprite(tierIndex, level) {
  // key 附加 PNG 就绪态：PNG 加载完成前烘焙的矢量缓存，在 PNG 就绪后自动重烘焙，
  // 避免真机（代码包加载慢）首帧用矢量烘焙后就永久显示矢量 —— 与 spintop _ensureTopSprite 同款机制。
  const pngOk = !!(_topImgs[tierIndex] && _topImgs[tierIndex]._ok && _topImgs[tierIndex].width > 0);
  const key = tierIndex + ':' + level + '|' + (pngOk ? 'png' : 'vec');
  const cached = _spriteCache[key];
  if (cached) {
    cached._lastAccess = Date.now(); // LRU：更新最后访问时间
    return cached;
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
  if (!cv || !cv.getContext) { return { fail: true }; }
  const c = cv.getContext('2d');
  if (!c) { return { fail: true }; }
  c.translate(half, half);
  // 等级光环已去除：随着陀螺旋转时虚线圆环不好看，等级通过中央数字标识即可
  // 本体：真实品质 PNG（未就绪时回退矢量）
  const topImg = _topImgs[tierIndex];
  if (topImg && topImg._ok && topImg.width > 0) {
    const tgt = R * 2.05;   // PNG 主体直径 ≈ 外环直径 2R（与对战一致）
    // 圆形遮罩：裁剪PNG图片，只显示中心陀螺部分，去除外面的灰色/紫色圆形背景和元素角标
    // 半径 R*0.95：确保裁剪掉PNG图片角落的元素角标（紫色小圆点），同时保留陀螺本体
    c.save();
    c.beginPath();
    c.arc(0, 0, R * 0.95, 0, Math.PI * 2);
    c.clip();
    c.drawImage(topImg, -tgt / 2, -tgt / 2, tgt, tgt);
    c.restore();
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
  _spriteCache[key] = entry;
  return entry;
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
  const el = ELEMENTS[bb.elementIdx];
  // 元素角标已移至外部 render.js 叠加显示（背包cell/合成台槽位右上角）
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
  const spr = getBeybladeSprite(bb.tierIndex, bb.level);
  ctx.save();
  ctx.translate(x, y);
  if (spr.fail) {
    ctx.restore();
    drawBeybladeVector(ctx, x, y, bb, scale, opts);
    return;
  }
  // 元素角标已去除：右上角属性角标（金木水火土）不需要，陀螺本体为纯净 PNG + 中央等级数字
  // 自转本体（精灵整体旋转 angle）
  // 绘制大小按 radius * 2 计算（和对战页面一致），不按 spr.size（包含光晕外沿，会偏大）
  // uniformSize：所有等级陀螺绘制尺寸一致（按最大等级5级的 radius 基准）
  let baseR = bb.radius;
  if (opts.uniformSize) {
    baseR = LEVELS[LEVELS.length - 1].radius;
  }
  let drawS = baseR * 2 * scale;
  // maxSize：限制最大绘制尺寸（保证不超出容器）
  if (opts.maxSize && drawS > opts.maxSize) {
    drawS = opts.maxSize;
  }
  ctx.rotate(a);
  try {
    ctx.drawImage(spr.canvas, -drawS / 2, -drawS / 2, drawS, drawS);
  } catch (e) {
    ctx.restore();
    drawBeybladeVector(ctx, x, y, bb, scale, opts);
    return;
  }
  ctx.restore();
}

module.exports = {
  Beyblade,
  TIERS,
  LEVELS,
  ELEMENTS,
  elementMultiplier,
  randomBeyblade,
  drawBeyblade
};
