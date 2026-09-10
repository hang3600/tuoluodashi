/**
 * 离屏画布透明底色回归（守防 2026-09-01 用户实机「大方块白底」）
 *
 * 根因：微信 wx.createOffscreenCanvas 在部分版本/机型上初始化为「不透明白底」，
 * 而 getBeybladeSprite（主页/图鉴/背包/扭蛋的陀螺图标）与 _bakeTopSprite（对战陀螺）
 * 只在画布中心画了一个圆盘，未先 clearRect → 圆盘四角露出白方块。
 * 同样受影响的还有 _starsBg / _buildArenaDecorSprite 等「局部覆盖」离屏烘焙
 * （叠到背景上时会整片泛白）。
 *
 * 本套件用「白底初始化 + 像素级回读」的 mock 坐实修复：
 *   1. getBeybladeSprite 烘焙出的离屏位图，四角像素必须为透明（alpha===0），而非不透明白；
 *   2. _bakeTopSprite 同上；
 *   3. 两次烘焙都必须在任何绘制指令之前先调用 clearRect（清成透明）。
 * 若日后回退到「不清空」，白底 mock 会让四角 alpha 仍为 255 → 断言失败，立即暴露。
 */

const path = require('path');

let pass = 0, fail = 0;
function ok(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + desc + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + desc + (extra ? ' — ' + extra : '')); }
}

// ── 离屏画布 mock：初始化为不透明白底，clearRect 把覆盖区清成透明 ──────────
function makeOffscreenRecorder(w, h) {
  // 模拟微信：初始化即不透明白（255,255,255,255）
  const buf = new Uint8ClampedArray(w * h * 4).fill(255);
  const ops = [];
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = {
    _buf: buf, _w: w, _h: h, _ops: ops, _tx: 0, _ty: 0,
    clearRect(x, y, cw, ch) {
      ops.push('clearRect');
      const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(w, Math.ceil(x + cw)), y1 = Math.min(h, Math.ceil(y + ch));
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0;
        }
    },
    translate(x, y) { this._tx += x; this._ty += y; ops.push('translate'); },
    rotate: noop, scale: noop, save: noop, restore: noop, clip: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, stroke: () => ops.push('draw'), fill: () => ops.push('draw'),
    fillRect: () => ops.push('draw'), strokeRect: noop,
    fillText: () => ops.push('draw'), strokeText: () => ops.push('draw'),
    drawImage: () => ops.push('draw'), setLineDash: noop,
    createRadialGradient: () => grad, createLinearGradient: () => grad, createPattern: () => null,
    measureText: () => ({ width: 10 }),
    getImageData(x, y, gw, gh) {
      const i = ((y | 0) * w + (x | 0)) * 4;
      return { data: [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]] };
    },
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, shadowBlur: 0, shadowColor: '', lineCap: '', lineJoin: '', globalCompositeOperation: ''
  };
  const cv = { width: w, height: h, getContext: () => ctx };
  return { cv, ctx };
}

// ── wx mock ─────────────────────────────────────────────────────────────
function installMock() {
  const rec = { offscreens: [], creates: 0 };
  global.wx = {
    getSystemInfoSync: () => ({ platform: 'devtools' }),
    createImage() {
      // 直接就绪，确保走真实品质 PNG 烘焙路径（最贴近「白底 PNG 叠白底画布」场景）
      const im = {
        width: 128, height: 128, _ok: true, _src: '', onload: null, onerror: null,
        set src(v) { this._src = v; this._ok = true; if (this.onload) this.onload(); },
        get src() { return this._src; }
      };
      return im;
    },
    createOffscreenCanvas(o) {
      const { cv } = makeOffscreenRecorder(o.width, o.height);
      rec.offscreens.push(cv); rec.creates++;
      return cv;
    }
  };
  return rec;
}

function firstDrawIdx(ops) { return ops.findIndex(o => o === 'draw'); }

async function main() {
  const rec = installMock();

  // 清缓存确保用上面装好的 wx mock 重新 require
  for (const f of ['../src/beyblade.js', '../battle/spintop.js', '../src/utils.js', '../src/imgb64.js']) {
    try { delete require.cache[require.resolve(f)]; } catch (e) {}
  }

  const beyblade = require('../src/beyblade.js');
  const spintop = require('../battle/spintop.js');
  const SpintopBattle = spintop.SpintopBattle;

  // ---- 1. getBeybladeSprite（主页/图鉴/背包/扭蛋的陀螺图标）----
  // 该函数未导出，改走 drawBeyblade（内部调用它烘焙离屏位图），再从 mock 录制的离屏画布中取回校验。
  console.log('▶ getBeybladeSprite 离屏透明（经 drawBeyblade）');
  const noopMain = {
    drawImage: () => {}, beginPath: () => {}, arc: () => {}, fill: () => {}, stroke: () => {},
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {}, scale: () => {},
    fillRect: () => {}, fillText: () => {}, strokeText: () => {}, clip: () => {}, closePath: () => {},
    setLineDash: () => {}, moveTo: () => {}, lineTo: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }), createLinearGradient: () => ({ addColorStop: () => {} }),
    measureText: () => ({ width: 10 }), getImageData: () => ({ data: [0, 0, 0, 0] }),
    strokeStyle: '', fillStyle: '', font: '', textAlign: '', textBaseline: '', globalAlpha: 1
  };
  const bb = new beyblade.Beyblade(0, 1);
  const beforeN = rec.offscreens.length;
  beyblade.drawBeyblade(noopMain, 100, 100, bb, 1, {});
  const spr = rec.offscreens[rec.offscreens.length - 1];
  ok('drawBeyblade 产出了离屏位图', rec.offscreens.length > beforeN && !!spr, 'offscreens=' + rec.offscreens.length);
  if (spr && spr.getContext) {
    const ctx = spr.getContext('2d');
    const corner = ctx.getImageData(0, 0, 1, 1).data;
    ok('四角像素为透明 (alpha===0)', corner[3] === 0, 'rgba=' + corner.join(','));
    const ci = ctx._ops.indexOf('clearRect');
    const di = firstDrawIdx(ctx._ops);
    ok('clearRect 被调用', ci !== -1);
    ok('clearRect 在任何绘制之前', ci !== -1 && (di === -1 || ci < di), 'ops=' + ctx._ops.slice(0, 6).join(','));
  }

  // ---- 2. _bakeTopSprite（对战陀螺）----
  console.log('▶ _bakeTopSprite 离屏透明');
  const self = {
    _topSpriteKeyFor: () => 'k',
    _radial(c, key, x0, y0, x1, y1, r0, r1, stops) {
      const g = c.createRadialGradient(x0, y0, r0, x1, y1, r1);
      if (stops) stops.forEach(s => g.addColorStop(s[0], s[1]));
      return g;
    },
    top: { radius: 40, trailColor: '#ff3344', color: '#33ff44', secondaryColor: '#4455ff' }
  };
  const t = { radius: 40, trailColor: '#ff3344', color: '#33ff44', secondaryColor: '#4455ff' };
  const cv2 = SpintopBattle.prototype._bakeTopSprite.call(self, t, 0, 1, { sprite: null, key: null });
  ok('返回离屏画布（非 null）', !!(cv2 && cv2.getContext), cv2 && cv2.getContext ? 'ok' : 'null');
  if (cv2 && cv2.getContext) {
    const ctx2 = cv2.getContext('2d');
    const corner2 = ctx2.getImageData(0, 0, 1, 1).data;
    ok('四角像素为透明 (alpha===0)', corner2[3] === 0, 'rgba=' + corner2.join(','));
    const ci2 = ctx2._ops.indexOf('clearRect');
    const di2 = firstDrawIdx(ctx2._ops);
    ok('clearRect 被调用', ci2 !== -1);
    ok('clearRect 在任何绘制之前', ci2 !== -1 && (di2 === -1 || ci2 < di2), 'ops=' + ctx2._ops.slice(0, 6).join(','));
  }

  // ---- 3. 反向：刻意验证 mock 真能暴露「不清空」——用一个会白底的对照烘焙 ----
  console.log('▶ 对照：不清空则四角不透明（证明 mock 有效，非永远透明）');
  const probe = makeOffscreenRecorder(88, 88);
  // 模拟「旧代码」：直接画圆盘、从不 clearRect
  probe.ctx.translate(44, 44);
  probe.ctx.beginPath(); probe.ctx.arc(0, 0, 40, 0, Math.PI * 2); probe.ctx.fill();
  const pc = probe.ctx.getImageData(0, 0, 1, 1).data;
  ok('不清空时四角保持不透明白 (alpha===255)', pc[3] === 255, 'rgba=' + pc.join(','));

  console.log('\n──────── 结果 ────────');
  console.log((fail === 0 ? '✅' : '❌') + ' 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('测试异常：', e); process.exit(1); });
