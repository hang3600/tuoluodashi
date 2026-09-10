/**
 * 工具函数
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function isPointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function formatNumber(num) {
  if (num >= 1e8) return (num / 1e8).toFixed(1) + '亿';
  if (num >= 1e4) return (num / 1e4).toFixed(1) + '万';
  return String(num);
}

function formatNumber0(num) {
  return Math.floor(num).toLocaleString('en-US');
}

/**
 * 矢量图标绘制器 — 用 Canvas 路径绘制 SF Symbols 风格图标，替代 emoji
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} type  coin | mute | unmute | share | check | bolt | star | snow
 * @param {number} cx   中心 x
 * @param {number} cy   中心 y
 * @param {number} size 图标尺寸（近似 font-size）
 * @param {string} color 主色
 */
function drawVectorIcon(ctx, type, cx, cy, size, color) {
  const s = size / 2;   // 半径基准
  ctx.save();
  ctx.fillStyle = color || '#ffffff';
  ctx.strokeStyle = color || '#ffffff';
  ctx.lineWidth = Math.max(1.5, size * 0.08);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (type) {
    case 'coin': {
      // 金币：外圆 + 内圆 + ¥ 符号
      ctx.fillStyle = '#FFD700';
      ctx.beginPath(); ctx.arc(cx, cy, s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#FFA000';
      ctx.lineWidth = Math.max(1, size * 0.06);
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.78, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#FFA000';
      ctx.lineWidth = Math.max(1.5, size * 0.09);
      // ¥ 符号
      const yArm = s * 0.35;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.4, cy - s * 0.45);
      ctx.lineTo(cx, cy - s * 0.05);
      ctx.lineTo(cx + s * 0.4, cy - s * 0.45);
      ctx.moveTo(cx, cy - s * 0.05);
      ctx.lineTo(cx, cy + s * 0.5);
      ctx.moveTo(cx - s * 0.35, cy + s * 0.1);
      ctx.lineTo(cx + s * 0.35, cy + s * 0.1);
      ctx.moveTo(cx - s * 0.35, cy + s * 0.3);
      ctx.lineTo(cx + s * 0.35, cy + s * 0.3);
      ctx.stroke();
      break;
    }
    case 'mute': {
      // 喇叭 + X
      const sw = s * 0.5;  // 喇叭口宽
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.55, cy - sw * 0.4);
      ctx.lineTo(cx - s * 0.15, cy - sw * 0.4);
      ctx.lineTo(cx + s * 0.15, cy - s * 0.55);
      ctx.lineTo(cx + s * 0.15, cy + s * 0.55);
      ctx.lineTo(cx - s * 0.15, cy + sw * 0.4);
      ctx.lineTo(cx - s * 0.55, cy + sw * 0.4);
      ctx.closePath();
      ctx.fill();
      // X
      ctx.lineWidth = Math.max(1.5, size * 0.1);
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.3, cy - s * 0.25);
      ctx.lineTo(cx + s * 0.6, cy + s * 0.25);
      ctx.moveTo(cx + s * 0.6, cy - s * 0.25);
      ctx.lineTo(cx + s * 0.3, cy + s * 0.25);
      ctx.stroke();
      break;
    }
    case 'unmute': {
      // 喇叭 + 声波弧线
      const sw = s * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.55, cy - sw * 0.4);
      ctx.lineTo(cx - s * 0.15, cy - sw * 0.4);
      ctx.lineTo(cx + s * 0.15, cy - s * 0.55);
      ctx.lineTo(cx + s * 0.15, cy + s * 0.55);
      ctx.lineTo(cx - s * 0.15, cy + sw * 0.4);
      ctx.lineTo(cx - s * 0.55, cy + sw * 0.4);
      ctx.closePath();
      ctx.fill();
      // 声波弧
      ctx.lineWidth = Math.max(1.5, size * 0.08);
      ctx.beginPath();
      ctx.arc(cx + s * 0.15, cy, s * 0.35, -Math.PI / 3, Math.PI / 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + s * 0.15, cy, s * 0.6, -Math.PI / 3.5, Math.PI / 3.5);
      ctx.stroke();
      break;
    }
    case 'share': {
      // 方框 + 向上箭头
      const bw = s * 0.7;
      ctx.lineWidth = Math.max(1.5, size * 0.09);
      // 方框底部
      ctx.beginPath();
      ctx.moveTo(cx - bw, cy + s * 0.1);
      ctx.lineTo(cx - bw, cy + s * 0.6);
      ctx.lineTo(cx + bw, cy + s * 0.6);
      ctx.lineTo(cx + bw, cy + s * 0.1);
      ctx.stroke();
      // 箭头
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.6);
      ctx.lineTo(cx, cy + s * 0.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.28, cy - s * 0.32);
      ctx.lineTo(cx, cy - s * 0.6);
      ctx.lineTo(cx + s * 0.28, cy - s * 0.32);
      ctx.stroke();
      break;
    }
    case 'check': {
      // 对勾 ✓
      ctx.lineWidth = Math.max(2, size * 0.12);
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.5, cy);
      ctx.lineTo(cx - s * 0.15, cy + s * 0.4);
      ctx.lineTo(cx + s * 0.55, cy - s * 0.4);
      ctx.stroke();
      break;
    }
    case 'bolt': {
      // 闪电 ⚡
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.15, cy - s * 0.65);
      ctx.lineTo(cx - s * 0.35, cy + s * 0.1);
      ctx.lineTo(cx - s * 0.05, cy + s * 0.1);
      ctx.lineTo(cx - s * 0.15, cy + s * 0.65);
      ctx.lineTo(cx + s * 0.35, cy - s * 0.1);
      ctx.lineTo(cx + s * 0.05, cy - s * 0.1);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'star': {
      // 五角星 ⭐
      const spikes = 5;
      const outerR = s * 0.7;
      const innerR = s * 0.3;
      ctx.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = (Math.PI * i) / spikes - Math.PI / 2;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'snow': {
      // 雪花 ❄️ — 6 条轴线 + 分叉
      ctx.lineWidth = Math.max(1.5, size * 0.07);
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI * i) / 3;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * s * 0.7, cy + Math.sin(a) * s * 0.7);
        ctx.stroke();
        // 分叉
        const bx = cx + Math.cos(a) * s * 0.45;
        const by = cy + Math.sin(a) * s * 0.45;
        const a1 = a + Math.PI / 6;
        const a2 = a - Math.PI / 6;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(a1) * s * 0.22, by + Math.sin(a1) * s * 0.22);
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(a2) * s * 0.22, by + Math.sin(a2) * s * 0.22);
        ctx.stroke();
      }
      break;
    }
    case 'club': {
      // 社区/游戏圈：对话气泡（圆角矩形 + 左下尾巴 + 三点省略）
      // 无配套 PNG，纯矢量绘制；24~36px 小尺寸下仍可辨识
      ctx.lineWidth = Math.max(1.5, size * 0.09);
      const bw = s * 1.7, bh = s * 1.1;
      const bx = cx - bw / 2, by = cy - bh / 2 - s * 0.12;
      const r = s * 0.26;
      ctx.beginPath();
      ctx.moveTo(bx + r, by);
      ctx.lineTo(bx + bw - r, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
      ctx.lineTo(bx + bw, by + bh - r);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
      ctx.lineTo(bx + bw * 0.36, by + bh);
      ctx.lineTo(bx + bw * 0.20, by + bh + s * 0.44);   // 尾巴尖
      ctx.lineTo(bx + bw * 0.20, by + bh);
      ctx.lineTo(bx + r, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
      ctx.lineTo(bx, by + r);
      ctx.quadraticCurveTo(bx, by, bx + r, by);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = color || '#ffffff';
      const dy = by + bh * 0.52;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(cx + i * s * 0.4, dy, Math.max(1.1, s * 0.1), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}

// ── 小游戏 PNG 加载加固 ───────────────────────────────────────────────
// 真机加载策略（v7 终解）：真机直接用「包内文件路径 + wx.createImage」加载——包内 PNG/JPG
// 随代码包分发，是微信小游戏最稳的资源加载路径，无需联网 / 写盘 / base64 bake。
// 模拟器（platform==='devtools'）保留内嵌 data URI（零 HTTP、规避模拟器路径解析差异）。
// 这些函数被 beyblade/spintop/render 共用；并入 utils（而非独立模块）以避免微信增量打包漏收新文件。

// 内嵌 base64 资源地图（src/imgb64.js）：全部图标/陀螺以 data URI 内嵌，
// 加载时优先用它，彻底规避 DevTools 模拟器「字符串/外部 PNG 路径 404」顽疾——加载不再发 HTTP 请求。
//
// ⚠️ 必须 try/catch 守卫（2026-09-02 启动性能优化）：imgb64.js 已加入 game.json 的
// packOptions.ignore —— 真机从不读它（真机 prepSrc 直接返回包内路径 images/<folder>/<file>），
// 但那 549KB base64 仍要随包下载 + 被 JS 引擎解析，是首屏下载耗时的主要死重。
// 文件仍保留在磁盘上（DevTools 本地编译不受 ignore 影响，模拟器预览照旧走 base64）；
// 真机打包时被排除 → require 抛异常 → 此处兜底成空对象。
// 若把这个守卫去掉，真机会因「模块缺失」直接崩在 require 上，务必保留。
let imgb64 = {};
try { imgb64 = require('./imgb64') || {}; } catch (e) { imgb64 = {}; }

// 产出最终加载源：模拟器 → 内嵌 data URI；真机 → 包内文件路径 images/<folder>/<file>。
// 真机为何用包内路径而非 data URI：battle/spintop.js（对战陀螺/HUD）与 src/render.js（图标）
// 均走本函数，真机实测「包内 PNG + wx.createImage」稳定出图，且省去几百 KB base64 解码。
// ⚠️ 已废弃方案，勿回退：曾试过「base64 → 写 USER_DATA_PATH 文件 → wx.loadImage」，
// 真机失效；且 wx.loadImage 官方文档查无此 API（只有 wx.createImage）。
function prepSrc(b64, file, folder) {
  // 模拟器：内嵌 data URI 最稳（零 HTTP、不依赖包路径解析），保持原行为不变。
  // 注意：真机启动瞬间 jsbridge 未就绪时 wx.getSystemInfoSync() 会抛异常
  // （"[jsbridge] invoke getSystemInfo fail: jsbridge not ready"），必须 try/catch，
  // 否则整条加载链被吞异常 → 资源永久缺失。异常时按真机处理（用包内路径，已验证可用）。
  let isDevtools = false;
  try {
    isDevtools = !!(typeof wx !== 'undefined' && wx.getSystemInfoSync && wx.getSystemInfoSync().platform === 'devtools');
  } catch (e) {
    isDevtools = false;
  }
  // arena 背景已随 battle 分包分发（battle/images/arena/<file>）：主包不内置、分包不可互读，
  // 故 arena 走 battle 分包内路径；其余资源仍在主包 images/<folder>/<file>。
  const _pkg = (folder === 'arena') ? ('battle/images/' + folder) : ('images/' + folder);
  if (isDevtools) {
    const real = b64 || ((imgb64[folder] || {})[file]) || null;
    return real || ('/' + _pkg + '/' + file); // 内嵌缺失兜底
  }
  // 真机：直接返回包内文件路径（wx.createImage + 包路径最稳），彻底绕开
  // 「base64 → USER_DATA_PATH 文件 → wx.loadImage」在真机失效、导致全系矢量回退的顽疾。
  // 包内 PNG/JPG 已随代码包分发（<pkg>/<folder>/<file>），无需联网/写盘/bake。
  return _pkg + '/' + file;
}

// 统一加载单个图片：优先 wx.createImage（小游戏最稳，包内路径 + data URI 均支持），
// 包内路径自动尝试「无前导斜杠」「前导斜杠」两种写法以兼容不同机型。
// cb(err, img)：成功时 err=null 且 img._ok=true
function loadOne(src, cb) {
  try {
    const make = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage
      : (typeof Image !== 'undefined' ? function () { return new Image(); } : null);
    if (!make) { cb(new Error('no image api')); return; }
    const im = make();
    im._ok = false;
    // 候选 src：包内路径尝试两种斜杠写法；data URI（模拟器）直接加载。
    const variants = [];
    if (typeof src === 'string' && src.slice(0, 5) === 'data:') {
      variants.push(src);
    } else {
      variants.push(src);
      variants.push(src.charAt(0) === '/' ? src.slice(1) : '/' + src);
    }
    let vi = 0;
    im.onload = function () { im._ok = true; cb(null, im); };
    im.onerror = function () {
      vi++;
      if (vi < variants.length) { im.src = variants[vi]; }
      else { cb(new Error('img load fail')); }
    };
    im.src = variants[0];
  } catch (e) { cb(e); }
}

// 把已加载图片按 maxDim 封顶降采样，限制解码内存（高端机 OOM 风险主因之一）。
// 返回封顶尺寸的离屏画布（wx.createOffscreenCanvas / document 回退），过小则原样返回。
// 无 wx/Image 的 headless 环境直接返回 im（测试不崩）。用于 home/arena/codex 等全分辨率 JPG 背景。
function downscaleToCap(im, maxDim) {
  if (!im) return im;
  const iw = im.width || 0, ih = im.height || 0;
  if (iw <= 0 || ih <= 0 || (iw <= maxDim && ih <= maxDim)) return im;
  const s = Math.min(maxDim / iw, maxDim / ih);
  const dw = Math.max(1, Math.round(iw * s)), dh = Math.max(1, Math.round(ih * s));
  try {
    let cv = null;
    if (typeof wx !== 'undefined' && wx.createOffscreenCanvas) cv = wx.createOffscreenCanvas({ width: dw, height: dh });
    else if (typeof document !== 'undefined' && document.createElement) { cv = document.createElement('canvas'); cv.width = dw; cv.height = dh; }
    if (cv && cv.getContext) {
      const c = cv.getContext('2d');
      if (c) { c.drawImage(im, 0, 0, dw, dh); return cv; }
    }
  } catch (e) {}
  return im;
}

module.exports = {
  clamp,
  lerp,
  easeOutBack,
  isPointInRect,
  formatNumber,
  formatNumber0,
  drawVectorIcon,
  prepSrc,
  loadOne,
  downscaleToCap
};
