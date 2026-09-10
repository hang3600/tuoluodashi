// 冒烟套件 · 对战页 HUD 框（电影感游戏界面）
//   目标：验证
//     (1) 无离屏画布环境（headless）下 draw() 不抛错、HUD 框烘焙安全跳过；
//     (2) 有离屏画布时 _buildHudFrameSprite 成功烘焙，且按 color|w|h 缓存（多次 _drawHudFrame 仅构建 1 次）；
//     (3) 低能量(energy/maxEnergy<0.3)危机暗角路径能执行且不抛错、确实发出 radial 渐变。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const { GameState } = require(path.join(__dirname, '..', 'src', 'game.js'));
const { Beyblade } = require(path.join(__dirname, '..', 'src', 'beyblade.js'));
const { SpintopBattle } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

// 计数型 ctx
function countingCtx() {
  const c = {
    _radial: 0, _drawImage: 0,
    measureText(t) { return { width: (t ? String(t).length : 0) * 8 }; },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { this._radial++; return { addColorStop() {} }; },
    drawImage() { this._drawImage++; },
  };
  return new Proxy(c, {
    get(t, p) { return p in t ? t[p] : (() => {}); },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function mkBattle() {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.start(new Beyblade(0, 1));
  b.countdown = 0;
  b.phase = 'playing';
  b.active = true;
  b._lowPerf = false;
  return b;
}

// ---------------------------------------------------------------------------
console.log('\n【战斗-HUD框-1】headless（无 wx/document）下 draw() 不抛错，HUD 框安全跳过');
{
  const b = mkBattle();
  const ctx = countingCtx();
  let threw = null;
  try { for (let f = 0; f < 5; f++) b.draw(ctx); } catch (e) { threw = e; }
  ok('5 帧 draw() 不抛错', !threw, threw && threw.message);
  ok('无离屏画布时 _hudFrameSprite 为 null（不绘制兜底）', b._hudFrameSprite === null || b._hudFrameSprite === undefined);
}

// ---------------------------------------------------------------------------
console.log('\n【战斗-HUD框-2】有离屏画布：烘焙成功 + 按 key 缓存（多次仅构建 1 次）');
{
  // 注入最小 document 桩（仅本子进程生效，run.js 用 spawn 隔离）
  const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => countingCtx() });
  const saved = global.document;
  global.document = { createElement: (t) => (t === 'canvas' ? fakeCanvas() : null) };

  const b = mkBattle();
  const ctx = countingCtx();
  let buildCalls = 0;
  const orig = b._buildHudFrameSprite.bind(b);
  b._buildHudFrameSprite = function (...a) { buildCalls++; return orig(...a); };

  b._drawHudFrame(ctx);
  b._drawHudFrame(ctx);
  b._drawHudFrame(ctx);

  ok('3 次 _drawHudFrame 仅构建 1 次 HUD 框位图（缓存命中）', buildCalls === 1, 'buildCalls=' + buildCalls);
  ok('HUD 框位图已缓存（_hudFrameSprite 非空）', !!b._hudFrameSprite);
  ok('烘焙后至少 1 次 drawImage 把框绘到屏幕', ctx._drawImage >= 1, 'drawImage=' + ctx._drawImage);

  // 变尺寸 → key 变 → 重建一次
  b.width = 400; b.height = 900;
  b._drawHudFrame(ctx);
  ok('尺寸变化触发重建（构建次数=2）', buildCalls === 2, 'buildCalls=' + buildCalls);

  global.document = saved;
}

// ---------------------------------------------------------------------------
console.log('\n【战斗-HUD框-3】低能量危机暗角：路径执行且不抛错、发出 radial 渐变');
{
  const saved = global.document;
  global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => countingCtx() }) };

  const b = mkBattle();
  b.game.energy = 10;            // maxEnergy 默认 150 → r≈0.067 < 0.3，进入危机
  const ctx = countingCtx();
  let threw = null, radialBefore = 0;
  try {
    b._drawHudFrame(ctx);        // 首次：构建 + 危机暗角
    radialBefore = ctx._radial;
    b._drawHudFrame(ctx);        // 二次：缓存命中 + 危机暗角
  } catch (e) { threw = e; }
  ok('低能量下 _drawHudFrame 不抛错', !threw, threw && threw.message);
  ok('危机暗角发出 radial 渐变（createRadialGradient 被调用）', radialBefore >= 1, 'radial=' + radialBefore);

  // 高能量不进入危机
  const b2 = mkBattle();
  b2.game.energy = 140;
  const ctx2 = countingCtx();
  b2._drawHudFrame(ctx2);
  ok('高能量(≈0.93)不触发危机暗角（radial=0）', ctx2._radial === 0, 'radial=' + ctx2._radial);

  global.document = saved;
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
