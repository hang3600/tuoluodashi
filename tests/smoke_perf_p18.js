// 冒烟套件 13 —— P1-8：其他性能项（每帧分配 / 重复计算治理）
//
// 修法回顾（audit P1-8）：
//   1) 传说光束：整体旋转画布 t*0.6，12 条光束角度变常量，渐变按索引 i 走 _grad 缓存
//   2) 战斗盘静态 8 层装饰：离屏烘焙成 _arenaDecorSprite（按 top.color+尺寸缓存），每帧 1 次 drawImage
//   3) 能量条 hlGrad：坐标恒定，走 this._grad 缓存（key = energyHl|ex|ey|energyH）
//   4) measureText：模块级 _mtCache + mtW(ctx,text) 按 font+text 缓存
//   5) 拖尾：对象池 _trailPool 复用 {x,y,alpha,size}，shift/reset 时回收
//   6) 展开运算符：this.buttons 改用 for 循环逐个 push，消除临时数组
//
// 本套件断言：修复后「逐帧分配 / 重复计算」确实被消除。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { Beyblade } = require(path.join(SRC_DIR, 'beyblade.js'));
const { SpintopBattle } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));
const { Renderer } = require(path.join(SRC_DIR, 'render.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 计数型 ctx：统计 createLinearGradient / createRadialGradient / measureText / drawImage 真实调用次数 */
function countingCtx() {
  const c = {
    _grad: 0, _measure: 0, _drawImage: 0,
    texts: [],
    measureText(t) { this._measure++; return { width: (t ? String(t).length : 0) * 8 }; },
    createLinearGradient() { this._grad++; return { addColorStop() {} }; },
    createRadialGradient() { this._grad++; return { addColorStop() {} }; },
    drawImage() { this._drawImage++; },
    fillText(t) { this.texts.push(String(t)); },
    save() {}, restore() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, fillRect() {}, clip() {}, translate() {}, rotate() {},
    setLineDash() {}, closePath() {}, roundRect() {},
  };
  return new Proxy(c, {
    get(t, p) { return p in t ? t[p] : (() => {}); },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function mkRenderer() {
  const g = new GameState();
  const canvas = { width: 375, height: 812 };
  const ctx = countingCtx();
  const savedLoad = Renderer.prototype._loadIcons;
  Renderer.prototype._loadIcons = function () {};
  const r = new Renderer(canvas, ctx, g, 56, 24, null);
  Renderer.prototype._loadIcons = savedLoad;
  r._gradCache = new Map();
  return { r, ctx };
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
console.log('\n【P1-8-1】传说光束：12 个渐变按索引缓存，首帧后零新建');
{
  const { r, ctx } = mkRenderer();
  // 用真实 Beyblade 实例（含 level/radius/power），否则 drawBeyblade → getBeybladeSprite(undefined) 会崩
  r.game.drawCard = { bb: new Beyblade(4, 1), t: 0.5 };     // 传说 tierIndex=4 → isLegend 命中
  r._gradCache = new Map();
  r.drawDrawCard();                                   // 首帧
  const keys1 = [...r._gradCache.keys()].filter(k => k.indexOf('legendBeam_') === 0);
  for (let f = 0; f < 10; f++) { r.game.drawCard.t = 0.5 + f * 0.01; r.drawDrawCard(); }
  const keys2 = [...r._gradCache.keys()].filter(k => k.indexOf('legendBeam_') === 0);
  ok('首帧建立 12 个光束渐变缓存键', keys1.length === 12, 'keys=' + keys1.length);
  ok('后续 10 帧光束渐变缓存键不再增长（全部命中）', keys2.length === 12,
    'keys=' + keys2.length);
}

// ---------------------------------------------------------------------------
console.log('\n【P1-8-2】战斗盘静态装饰：构建一次，后续帧复用位图（零重建）');
{
  const b = mkBattle();
  const ctx = countingCtx();
  b._arenaDecorSprite = null; b._arenaDecorKey = '';
  // 模拟「离屏画布可用」：让 _buildArenaDecorSprite 成功返回一个位图对象。
  // 真实优化点是「离屏构建（含烘焙）只发生一次」，故统计 _buildArenaDecorSprite 调用次数。
  let buildCalls = 0;
  const origBuild = b._buildArenaDecorSprite.bind(b);
  b._buildArenaDecorSprite = function (...a) { buildCalls++; return origBuild(...a) || { _fakeSprite: true, width: a[0], height: a[1] }; };

  b.draw(ctx);
  for (let f = 0; f < 10; f++) b.draw(ctx);
  ok('11 帧仅构建 1 次静态装饰位图（后续复用缓存）', buildCalls === 1, 'buildCalls=' + buildCalls);
  ok('装饰位图已缓存（_arenaDecorSprite 非空）', !!b._arenaDecorSprite, 'sprite=' + (b._arenaDecorSprite ? 'set' : 'null'));
}

// ---------------------------------------------------------------------------
console.log('\n【P1-8-3】能量条 hlGrad：坐标恒定，走 _grad 缓存零新建');
{
  const { r, ctx } = mkRenderer();
  r._gradCache = new Map();
  r.drawHeader();                                    // 首帧
  const keys1 = [...r._gradCache.keys()].filter(k => k.indexOf('energyHl|') === 0);
  for (let f = 0; f < 10; f++) r.drawHeader();        // 后续帧
  const keys2 = [...r._gradCache.keys()].filter(k => k.indexOf('energyHl|') === 0);
  ok('energyHl 缓存键恰好 1 个（首帧建、后续命中）', keys1.length === 1,
    'keys1=' + JSON.stringify(keys1));
  ok('后续 10 帧 energyHl 缓存键不再增长', keys2.length === 1,
    'keys2=' + keys2.length);
}

// ---------------------------------------------------------------------------
console.log('\n【P1-8-4】measureText：静态文本按 font+text 缓存，重复测量零调用');
{
  // 隔离：重新加载 render.js 以清空模块级 _mtCache（否则前面各段已预热，本段首调即命中缓存）
  delete require.cache[require.resolve(path.join(SRC_DIR, 'render.js'))];
  const { Renderer: FR } = require(path.join(SRC_DIR, 'render.js'));
  const g = new GameState();
  const ctx = countingCtx();
  const savedLoad = FR.prototype._loadIcons; FR.prototype._loadIcons = function () {};
  const r = new FR({ width: 375, height: 812 }, ctx, g, 56, 24, null);
  FR.prototype._loadIcons = savedLoad;
  // 复位 ctx.font：drawHeader 在首段测量（行652 金币文本）前未显式设 font，
  // 上一帧残留的 font 会污染 mtW 缓存键导致误判；统一复位为常量保证两次调用一致。
  ctx.font = '';
  ctx._measure = 0;
  r.drawHeader();                       // 首次：所有静态文本真实测量
  const m1 = ctx._measure;
  ctx.font = '';
  r.drawHeader();                       // 二次：全部命中缓存
  const m2 = ctx._measure - m1;
  ok('首次 drawHeader 触发 measureText（>0）', m1 > 0, 'm1=' + m1);
  ok('二次 drawHeader 静态文本 measureText 全部命中缓存（增量 0）', m2 === 0, 'm2=' + m2);
}

// ---------------------------------------------------------------------------
console.log('\n【P1-8-5】拖尾对象池：连续帧复用同一对象引用，不再每帧 new');
{
  const b = mkBattle();
  const ctx = countingCtx();
  const top = b.top;
  const seen = [];
  // 跑 50 帧：每帧强制高速旋转（摩擦会衰减，故每帧重设），触发拖尾并越过 30 上限进入回收
  for (let f = 0; f < 50; f++) {
    top.angularVelocity = top.maxSpeed * 2;   // >2，触发拖尾生成
    b.update(1 / 60);
    if (b.trailPoints.length) seen.push(b.trailPoints[b.trailPoints.length - 1]);
  }
  const refs = new Map();
  let reused = false;
  for (const p of seen) { if (refs.has(p)) { reused = true; break; } refs.set(p, true); }
  ok('拖尾对象跨帧复用（同一引用出现 ≥2 次）', reused, 'seen=' + seen.length);
  ok('拖尾池已初始化', Array.isArray(b._trailPool), 'poolLen=' + (b._trailPool ? b._trailPool.length : 'n/a'));
  ok('拖尾点数受 30 上限约束', b.trailPoints.length <= 30, 'len=' + b.trailPoints.length);
}

// ---------------------------------------------------------------------------
console.log('\n【P1-8-6】展开运算符：this.buttons 不再 push(...rects)，且行为等价');
{
  const { r } = mkRenderer();
  const src = fs.readFileSync(path.join(SRC_DIR, 'render.js'), 'utf8');
  const hasSpread = /\.push\(\s*\.\.\.\s*rects/.test(src);
  ok('render.js 已无 this.buttons.push(...rects) 展开写法', !hasSpread, 'hasSpread=' + hasSpread);

  const b = mkBattle();
  r.buttons = [];
  r.game.battle = b;
  b.draw = function () { return [{ x: 1, y: 2, w: 3, h: 4 }, { x: 5, y: 6, w: 7, h: 8 }]; };
  r.drawSpintopBattle(1 / 60);
  ok('drawSpintopBattle 仍把 rects 逐个收集进 this.buttons（2 个）', r.buttons.length === 2,
    'len=' + r.buttons.length);
}

console.log('\n' + (fail === 0 ? '✅' : '❌') + ' P1-8 性能项套件：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
