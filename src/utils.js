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
// 历史坑：小游戏真机（iOS/Android）上 wx.createImage + dataURI 的 onload 时而不触发 / 不解码，
// 导致 Image._ok 永远为 false、离屏烘焙与图标绘制永久走矢量/文字回退，而本地 DevTools 反而正常。
// 最稳的修复：把 base64 写入 wx.env.USER_DATA_PATH 本地文件，再用「文件路径」加载（真机最稳路径）。
// 这些函数被 beyblade/spintop/render 共用；并入 utils（而非独立模块）以避免微信增量打包漏收新文件。

// 把 base64 dataURI 写入 USER_DATA_PATH，返回本地文件绝对路径；不可用时返回 null
function bakeBase64ToUserPath(b64, fileName) {
  try {
    if (typeof wx === 'undefined' || !wx.getFileSystemManager || !wx.env || !wx.env.USER_DATA_PATH) return null;
    const m = /^data:[^;]*;base64,(.*)$/.exec(b64 || '');
    if (!m || !m[1]) return null;
    const fs = wx.getFileSystemManager();
    const dir = wx.env.USER_DATA_PATH + '/b64img';
    try { fs.mkdirSync(dir); } catch (e) { /* 已存在则忽略 */ }
    const filePath = dir + '/' + fileName;
    fs.writeFileSync(filePath, m[1], 'base64');
    return filePath;
  } catch (e) { return null; }
}

// 内嵌 base64 资源地图（src/imgb64.js）：全部图标/陀螺以 data URI 内嵌，
// 加载时优先用它，彻底规避 DevTools 模拟器「字符串/外部 PNG 路径 404」顽疾——加载不再发 HTTP 请求。
const imgb64 = require('./imgb64');

// 产出最终加载源：优先调用方传入的 base64 → 其次内嵌 base64 地图（必中）→ 极端缺失才回退包内文件路径。
// 模拟器（platform==='devtools'）直接用 data URI（最稳）；真机把 base64 写到 USER_DATA_PATH 再用文件路径加载（最稳）。
function prepSrc(b64, file, folder) {
  const real = b64 || ((imgb64[folder] || {})[file]) || null;
  if (!real) return '/images/' + folder + '/' + file; // 内嵌缺失的兜底（真机/上传包可用）
  const isDevtools = (typeof wx !== 'undefined' && wx.getSystemInfoSync && wx.getSystemInfoSync().platform === 'devtools');
  if (isDevtools) return real; // 模拟器：data URI 最稳
  const fp = bakeBase64ToUserPath(real, file); // 真机：写 USER_DATA_PATH 后用文件路径
  return fp || real;
}

// 统一加载单个图片：优先 wx.loadImage（Promise），回退 wx.createImage / 浏览器 Image + onload
// cb(err, img)：成功时 err=null 且 img._ok=true
function loadOne(src, cb) {
  try {
    if (typeof wx !== 'undefined' && wx.loadImage) {
      wx.loadImage(src).then(function (im) { im._ok = true; cb(null, im); })
        .catch(function () { cb(new Error('loadImage fail')); });
      return;
    }
    const make = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage
      : (typeof Image !== 'undefined' ? function () { return new Image(); } : null);
    if (!make) { cb(new Error('no image api')); return; }
    const im = make();
    im.onload = function () { im._ok = true; cb(null, im); };
    im.onerror = function () { cb(new Error('img onerror')); };
    im.src = src;
  } catch (e) { cb(e); }
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
  loadOne
};
