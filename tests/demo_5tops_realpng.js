/**
 * 直接调用 src/beyblade.js —— 用 5 张 tops PNG 的【真实文件字节】验证 v8 加载通路。
 *
 * 与 smoke_topimg_load.js（纯 mock 假数据）不同，本脚本：
 *   1. 真实读取 images/tops/top-{earth,wood,water,fire,metal}.png 的磁盘字节；
 *   2. mock 的 wx.createImage 会从磁盘读真实 PNG，解析 IHDR 拿 256×256 尺寸并触发 onload
 *      —— 等价于真机「包内路径 + wx.createImage」成功加载；
 *   3. 直接调用 beyblade.js 的 drawBeyblade()，对 5 个 tier（土/木/水/火/金）各画一次，
 *      断言每个陀螺都走了 PNG 分支（sprite 烘焙时把真实 image 画进离屏画布）。
 *
 * 目的：证明 v8「一次性建 image + 单次赋 src」在「用真实文件喂入」下也能正确 onload
 *       并出图，而非矢量回退。运行：node tests/demo_5tops_realpng.js
 */
const fs = require('fs');
const path = require('path');
const BASE = path.join(__dirname, '..');
const MOD = path.join(BASE, 'src', 'beyblade.js');

// PNG IHDR：字节 16-23 是 width/height（大端）
function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const noop = () => {};
const grad = { addColorStop: noop };

// 捕获 [topimg] 诊断日志
const topimgLogs = [];
const origLog = console.log;
console.log = function (...a) { if (a[0] === '[topimg]') topimgLogs.push(a.slice(1).join(' ')); else origLog.apply(console, a); };

// 统计：sprite 烘焙时把真实 image 画进离屏画布的次数
let pngDraws = 0;
const allImgs = [];
const srcMap = {};

function makeCtx() {
  const ctx = {
    drawImage(...a) {
      // a[0] 为真实 image（MockImage，带 onload 函数）；offscreen canvas 不会带
      if (a[0] && typeof a[0].onload === 'function') pngDraws++;
    },
    beginPath: noop, arc: noop, save: noop, restore: noop, clip: noop, stroke: noop,
    fill: noop, fillRect: noop, strokeRect: noop, fillText: noop, strokeText: noop,
    translate: noop, rotate: noop, scale: noop, setLineDash: noop, closePath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop, clearRect: noop,
    createRadialGradient: () => grad, createLinearGradient: () => grad, createPattern: () => null,
    measureText: () => ({ width: 10 }),
    set strokeStyle(v) {}, set fillStyle(v) {}, set lineWidth(v) {}, set font(v) {},
    set textAlign(v) {}, set textBaseline(v) {}, set globalAlpha(v) {}, set shadowBlur(v) {},
    set shadowColor(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set globalCompositeOperation(v) {}
  };
  return ctx;
}
const ctx = makeCtx();

// mock wx：createImage 从磁盘读真实 PNG（模拟真机包内路径加载）；createOffscreenCanvas 用同一 ctx
global.wx = {
  getSystemInfoSync() { return { platform: 'ios' }; },  // 真机
  createImage() {
    const im = {
      _src: '', _ok: false, width: 0, height: 0, onload: null, onerror: null,
      set src(v) {
        this._src = v;
        srcMap[v] = this;
        const m = /images\/([^/]+)\/(.+)$/.exec(v);
        if (m) {
          const fp = path.join(BASE, v);   // 工程根 + images/tops/xxx.png
          fs.readFile(fp, (e, buf) => {
            if (e || !buf) { this.onerror && this.onerror({ errMsg: 'ENOENT ' + fp }); return; }
            const sz = pngSize(buf);
            if (!sz) { this.onerror && this.onerror({ errMsg: 'not png ' + fp }); return; }
            this.width = sz.w; this.height = sz.h;
            this.onload && this.onload();   // 真实 PNG 字节 → onload（等价于真机加载成功）
          });
        }
        // data URI 分支（模拟器）本 demo 不触发
      },
      get src() { return this._src; }
    };
    allImgs.push(im);
    return im;
  },
  createOffscreenCanvas(o) {
    const c = { width: o.width, height: o.height };
    c.getContext = () => ctx;
    return c;
  }
};

(async () => {
  const B = require(MOD);
  const TIER_NAMES = ['土', '木', '水', '火', '金'];                 // TIERS[0..4]
  const EXPECTED = ['top-earth.png', 'top-wood.png', 'top-water.png', 'top-fire.png', 'top-metal.png'];

  console.log('\n═══ 直接调用 beyblade.js：生成金木水火土 5 个陀螺 ═══\n');
  console.log('① 渲染期首次调用 drawBeyblade（触发 v8 加载（jsbridge 就绪门禁），发 35 个 src）');
  for (let t = 0; t < 5; t++) {
    B.drawBeyblade(ctx, 0, 0, new B.Beyblade(t, 1), 1);
  }
  await sleep(250);   // 等真实文件读取 + onload

  console.log('② 再画一次（此刻 PNG 应已就绪，走 PNG 分支烘焙 sprite）');
  for (let t = 0; t < 5; t++) {
    B.drawBeyblade(ctx, 0, 0, new B.Beyblade(t, 1), 1);
  }
  await sleep(50);

  // 硬证据：检查 5 张陀螺 PNG 是否真实就绪（用真实文件字节喂入后）
  console.log('\n═══ 验证结果 ═══\n');
  let allOk = true;
  for (let t = 0; t < 5; t++) {
    const im = srcMap['images/tops/' + EXPECTED[t]];
    const ok = !!(im && im._ok && im.width > 0);
    if (!ok) allOk = false;
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + TIER_NAMES[t] + '系陀螺 (' + EXPECTED[t] + ')'
      + ' —— ' + (im ? ('width=' + im.width + ' _ok=' + im._ok) : '未发起加载'));
  }

  // 木系现在走 level 专属贴图（wood-lv1.png）
  const woodLv1 = srcMap['images/tops/wood-lv1.png'];
  const woodLv1Ok = !!(woodLv1 && woodLv1._ok && woodLv1.width > 0);
  if (!woodLv1Ok) allOk = false;
  console.log('  ' + (woodLv1Ok ? '✅' : '❌') + ' 木系 level 1 专属贴图 (wood-lv1.png)'
    + ' —— ' + (woodLv1 ? ('width=' + woodLv1.width + ' _ok=' + woodLv1._ok) : '未发起加载'));

  // 水系现在走 level 专属贴图（water-lv1.png）
  const waterLv1 = srcMap['images/tops/water-lv1.png'];
  const waterLv1Ok = !!(waterLv1 && waterLv1._ok && waterLv1.width > 0);
  if (!waterLv1Ok) allOk = false;
  console.log('  ' + (waterLv1Ok ? '✅' : '❌') + ' 水系 level 1 专属贴图 (water-lv1.png)'
    + ' —— ' + (waterLv1 ? ('width=' + waterLv1.width + ' _ok=' + waterLv1._ok) : '未发起加载'));

  // 火系现在走 level 专属贴图（fire-lv1.png）
  const fireLv1 = srcMap['images/tops/fire-lv1.png'];
  const fireLv1Ok = !!(fireLv1 && fireLv1._ok && fireLv1.width > 0);
  if (!fireLv1Ok) allOk = false;
  console.log('  ' + (fireLv1Ok ? '✅' : '❌') + ' 火系 level 1 专属贴图 (fire-lv1.png)'
    + ' —— ' + (fireLv1 ? ('width=' + fireLv1.width + ' _ok=' + fireLv1._ok) : '未发起加载'));

  // 土系现在走 level 专属贴图（earth-lv1.png）
  const earthLv1 = srcMap['images/tops/earth-lv1.png'];
  const earthLv1Ok = !!(earthLv1 && earthLv1._ok && earthLv1.width > 0);
  if (!earthLv1Ok) allOk = false;
  console.log('  ' + (earthLv1Ok ? '✅' : '❌') + ' 土系 level 1 专属贴图 (earth-lv1.png)'
    + ' —— ' + (earthLv1 ? ('width=' + earthLv1.width + ' _ok=' + earthLv1._ok) : '未发起加载'));

  const pngBranch = pngDraws >= 5;   // 5 个 tier 各把真实 image 画进 sprite 一次
  console.log('');
  console.log('  ' + (pngBranch ? '✅' : '❌') + ' 5 个陀螺均走 PNG 分支出图（sprite 内真实 drawImage 调用 = ' + pngDraws + ' 次）');
  console.log('  ' + (topimgLogs.length ? '✅' : '⚠️') + ' [topimg] 诊断日志 ' + topimgLogs.length + ' 条（真机排障同款）');
  if (topimgLogs.length) console.log('     样本: ' + topimgLogs.slice(0, 4).join(' || '));

  const pass = allOk && pngBranch;
  console.log('\n═══ ' + (pass ? '✅ 5 个元素陀螺全部出图，v8 加载通路验证通过' : '❌ 验证失败') + ' ═══\n');
  console.log('（注：本 demo 用真实 PNG 文件字节喂入 mock 的 wx.createImage，等价真机“包内路径+PNG 成功加载”' +
    '；本地预览若仍显示矢量，请确认已重新点「预览」生成新二维码）\n');
  process.exit(pass ? 0 : 1);
})();
