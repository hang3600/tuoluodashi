// 冒烟套件 45 —— 对战循环渐变缓存（battle/spintop.js 的 _gradFor）
//
// 背景：src/render.js 早已有 _grad/_gradFor 渐变缓存（38 处里 34 处已接入），
// 但 battle/spintop.js 完全没有——对战每帧稳定新建 9 个 CanvasGradient（返回胶囊 2、
// 战斗盘装饰 2、敌血条 1、分数背板 1、怒气条 1、新手引导 2），是低端机（OPPO R17）
// 满帧 GC 抖动的真实热点。
//
// 修法：新增 _gradFor(ctx, key, create)。与 render.js 的关键差异——
//   render.js 用 `ctx === this.ctx` 守卫来避免跨 ctx 复用 CanvasGradient；
//   但 spintop 的 draw(ctx) 的 ctx 是**入参**，且并存多个离屏 ctx（背景 / 陀螺精灵 / 装饰），
//   恒等比较永远不命中 = 等于没缓存。所以改成 WeakMap 按 ctx 身份键控，每个 ctx 一张 Map。
//
// 视觉零回归的机制：key 由「运行时坐标 + 色标」拼成。
//   静态渐变 → key 恒定 → 命中缓存；
//   动画渐变（依赖 Date.now()）→ key 每帧变 → 天然不命中。
//   所以动画渐变（命中白闪 / 失败暗角 / 低能量暗角 / 抽打手势）**刻意不接入**，
//   连拼 key 的开销都省掉；本套件对此也有反向断言。
//
// 本套件断言：静态渐变首帧建缓存、后续帧零新建；动画渐变仍逐帧新建（证明没被错误缓存）；
//            跨 ctx 隔离；超 cap 时 FIFO 淘汰而非清表。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { GameState } = require(path.join(ROOT, 'src', 'game.js'));
const { Beyblade } = require(path.join(ROOT, 'src', 'beyblade.js'));
const { SpintopBattle } = require(path.join(ROOT, 'battle', 'spintop.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 计数型 ctx：统计 createLinearGradient / createRadialGradient 的真实调用次数 */
function countingCtx() {
  const c = {
    _grad: 0,
    measureText(t) { return { width: (t ? String(t).length : 0) * 8 }; },
    createLinearGradient() { this._grad++; return { addColorStop() {}, _id: 'lin' + this._grad }; },
    createRadialGradient() { this._grad++; return { addColorStop() {}, _id: 'rad' + this._grad }; },
    drawImage() {}, fillText() {},
    save() {}, restore() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, fillRect() {}, clip() {}, translate() {}, rotate() {},
    scale() {}, setLineDash() {}, closePath() {}, roundRect() {},
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
console.log('\n【1】playing 稳定帧：静态渐变零新建（原 9 个/帧）');
{
  const b = mkBattle();
  const ctx = countingCtx();

  b.draw(ctx);                                   // 首帧：建缓存
  const f1 = ctx._grad;
  ctx._grad = 0; b.draw(ctx);
  const f2 = ctx._grad;
  ctx._grad = 0;
  for (let i = 0; i < 10; i++) b.draw(ctx);
  const f10 = ctx._grad;

  ok('首帧确有渐变新建（缓存未空转）', f1 > 0, 'f1=' + f1);
  ok('第 2 帧渐变新建 = 0（全部命中缓存）', f2 === 0, 'f2=' + f2);
  ok('后续 10 帧渐变新建 = 0（稳定态零分配）', f10 === 0, 'f10=' + f10);

  const m = b._gradCtxCache.get(ctx);
  ok('该 ctx 已建立独立缓存表', !!m && m.size > 0, 'size=' + (m ? m.size : 0));

  // 逐个断言 9 个静态站点都真的进了缓存（防止后续改动漏接）
  const prefixes = ['back|', 'backhl|', 'dish|', 'dishhl|', 'hp|', 'plate|', 'ragebg|', 'tuto|', 'tutohl|'];
  const keys = m ? [...m.keys()] : [];
  for (const p of prefixes) {
    ok('静态站点已接入缓存: ' + p, keys.some(k => k.indexOf(p) === 0), 'keys=' + keys.join(','));
  }
  ok('缓存键数 = 9（不多不少，无变动 key 误入）', keys.length === 9,
    'size=' + keys.length + ' keys=' + keys.join(','));
}

// ---------------------------------------------------------------------------
console.log('\n【2】result 结算页：胜利底光 + 3 个 CTA 按钮渐变同样零重建');
{
  const b = mkBattle();
  const ctx = countingCtx();
  b.phase = 'result'; b.result = 'win'; b._resultStartTime = Date.now();

  b.draw(ctx);
  const r1 = ctx._grad;
  ctx._grad = 0;
  for (let i = 0; i < 10; i++) b.draw(ctx);
  const r10 = ctx._grad;

  ok('结算首帧有新建', r1 > 0, 'r1=' + r1);
  ok('结算后续 10 帧渐变新建 = 0', r10 === 0, 'r10=' + r10);

  const keys = [...b._gradCtxCache.get(ctx).keys()];
  ok('胜利底光已缓存 (win|)', keys.some(k => k.indexOf('win|') === 0));
  ok('CTA 按钮渐变已缓存 (btn|，按 x/y/h/color 区分)',
    keys.filter(k => k.indexOf('btn|') === 0).length >= 2,
    'btn keys=' + keys.filter(k => k.indexOf('btn|') === 0).join(','));
}

// ---------------------------------------------------------------------------
console.log('\n【3】反向断言：动画渐变刻意不接缓存，仍逐帧新建（视觉零回归）');
{
  const b = mkBattle();
  const ctx = countingCtx();
  b.draw(ctx);                                   // 先把静态缓存建好
  const sizeBefore = b._gradCtxCache.get(ctx).size;

  // 命中白闪：alpha/r 每帧衰减 → 若被错误缓存，画面会「定格」在第一帧亮度
  b.hitFlashes = [{ x: 100, y: 300, r: 40, alpha: 0.9, warm: true }];
  ctx._grad = 0;
  b._drawHitFlashes(ctx);
  const h1 = ctx._grad;
  b.hitFlashes[0].alpha = 0.5; b.hitFlashes[0].r = 55;
  ctx._grad = 0;
  b._drawHitFlashes(ctx);
  const h2 = ctx._grad;

  ok('命中白闪每帧新建渐变（未被错误缓存）', h1 === 1 && h2 === 1, 'h1=' + h1 + ' h2=' + h2);

  // 失败暗角：pulse 依赖时间
  ctx._grad = 0;
  b._drawLoseVignette(ctx, 375, 812, 1.0);
  b._drawLoseVignette(ctx, 375, 812, 1.5);
  ok('失败暗角每帧新建渐变（脉冲不被冻结）', ctx._grad === 2, 'grad=' + ctx._grad);

  ok('动画渐变未污染缓存表（size 不增长）',
    b._gradCtxCache.get(ctx).size === sizeBefore,
    'before=' + sizeBefore + ' after=' + b._gradCtxCache.get(ctx).size);
}

// ---------------------------------------------------------------------------
console.log('\n【4】跨 ctx 隔离：CanvasGradient 不在不同 ctx 间串用');
{
  const b = mkBattle();
  const ctxA = countingCtx();
  const ctxB = countingCtx();

  const gA = b._gradFor(ctxA, 'same|key', () => ctxA.createLinearGradient(0, 0, 1, 1));
  const gB = b._gradFor(ctxB, 'same|key', () => ctxB.createLinearGradient(0, 0, 1, 1));
  const gA2 = b._gradFor(ctxA, 'same|key', () => ctxA.createLinearGradient(0, 0, 1, 1));

  ok('相同 key + 不同 ctx → 各自独立渐变对象', gA !== gB);
  ok('相同 key + 相同 ctx → 复用同一对象', gA === gA2);
  ok('ctxA / ctxB 各持一张缓存表',
    b._gradCtxCache.get(ctxA) !== b._gradCtxCache.get(ctxB));
}

// ---------------------------------------------------------------------------
console.log('\n【5】cap 溢出：FIFO 淘汰最老键，不 clear() 整表（避免缓存抖动）');
{
  const b = mkBattle();
  const ctx = countingCtx();
  for (let i = 0; i < 200; i++) {
    b._gradFor(ctx, 'k' + i, () => ctx.createLinearGradient(0, 0, 1, 1));
  }
  const m = b._gradCtxCache.get(ctx);
  ok('缓存表被限幅（size <= 128）', m.size <= 128, 'size=' + m.size);
  ok('最新键仍在表内（未被整表 clear）', m.has('k199'), 'has k199=' + m.has('k199'));
  ok('最老键已被淘汰', !m.has('k0'), 'has k0=' + m.has('k0'));
  ok('限幅后仍保留大量热键（非清空）', m.size >= 64, 'size=' + m.size);
}

// ---------------------------------------------------------------------------
console.log('\n【6】健壮性：ctx 缺失时直通 create()，不崩');
{
  const b = mkBattle();
  let created = 0;
  const g = b._gradFor(null, 'x', () => { created++; return { _fake: 1 }; });
  ok('ctx=null 时仍返回渐变对象', !!g && g._fake === 1);
  ok('ctx=null 时调用了 create()', created === 1, 'created=' + created);
}

// ---------------------------------------------------------------------------
console.log('\n' + (fail === 0 ? '✅' : '❌') +
  ' 对战渐变缓存回归：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
