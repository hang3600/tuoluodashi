/**
 * 运行性能优化修复冒烟（对应「运行得分 86 / 内存 52 / 低端机 CPU 瓶颈」）
 *   1) _clearBattleCaches：内存告警时释放 5 张全屏离屏 canvas + 背景图，返回 5；下一帧自修复重建。
 *   2) downscaleToCap：过大 JPG 背景(1920x1080)→封顶720离屏(720x405)；小图/等于封顶/无 wx/null 均安全。
 * 注：真实降幅（内存峰值、低端机 FPS）须真机体验分复测确认（本机无法跑性能分析器）。
 */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

// ---- 1) _clearBattleCaches ----
console.log('\n【P-1】_clearBattleCaches 释放对战离屏缓存（高端机 OOM 主因之一）');
const Spintop = require('../battle/spintop').SpintopBattle;
const stub = {
  _bgSprite: { w: 1 }, _bgSpriteW: 10, _bgSpriteH: 20,
  _arenaDecorSprite: { w: 1 }, _arenaDecorKey: 'k',
  _sceneSprite: { w: 1 }, _sceneKey: 'k',
  _starsBg: { w: 1 }, _starsBgW: 10, _starsBgH: 20,
  _hudFrameSprite: { w: 1 }, _hudFrameKey: 'k',
  _bgImage: { width: 100 }, _bgImageLoading: true, _bgImageFailed: true
};
const ret = Spintop.prototype._clearBattleCaches.call(stub);
ok('返回 5（离屏 canvas 张数）', ret === 5, 'ret=' + ret);
ok('_bgSprite 已释放', stub._bgSprite === null);
ok('_arenaDecorSprite 已释放', stub._arenaDecorSprite === null);
ok('_sceneSprite 已释放', stub._sceneSprite === null);
ok('_starsBg 已释放', stub._starsBg === null);
ok('_hudFrameSprite 已释放', stub._hudFrameSprite === null);
ok('_bgImage 已释放', stub._bgImage === null);
ok('_bgImageLoading 复位', stub._bgImageLoading === false);
ok('_bgImageFailed 复位', stub._bgImageFailed === false);

// ---- 2) downscaleToCap ----
console.log('\n【P-2】downscaleToCap 背景封顶 720 降采样');
global.wx = {
  createOffscreenCanvas(o) { return { width: o.width, height: o.height, getContext: () => ({ drawImage() {} }) }; }
};
const { downscaleToCap } = require('../src/utils');
const big = { width: 1920, height: 1080 };
const cap = downscaleToCap(big, 720);
ok('过大图(1920x1080)→封顶720离屏(720x405)', cap && cap.width === 720 && cap.height === 405, JSON.stringify(cap && { w: cap.width, h: cap.height }));
const small = { width: 200, height: 100 };
ok('小图(≤720)原样返回', downscaleToCap(small, 720) === small);
const eq = { width: 720, height: 405 };
ok('等于封顶尺寸原样返回', downscaleToCap(eq, 720) === eq);
delete global.wx;
const noWx = { width: 1920, height: 1080 };
ok('无 wx 环境不崩、原样返回', downscaleToCap(noWx, 720) === noWx);
ok('null 输入安全返回 null', downscaleToCap(null, 720) === null);

console.log('\n══════════════════════════════════════');
console.log((fail === 0 ? '✅' : '❌') + ' 运行性能修复冒烟：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
