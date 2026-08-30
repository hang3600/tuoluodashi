// 冒烟套件 10 —— P1-5 粒子颜色与淡出
//
// 背景：_drawParticles 为了性能用"单次 beginPath + 单次 fill"画完所有粒子，
// 代价是 fillStyle 硬取 this.top.color、且完全不设 globalAlpha ——
// 于是金色暴击粒子被画成陀螺色（p.color 被丢弃），粒子只缩小、不淡出、到点硬消失。
//
// 修法：按「颜色 + 量化 alpha」分批，每批一次 fill()。本套件用记录型 mock ctx 直接断言绘制行为。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { Beyblade } = require(path.join(SRC_DIR, 'beyblade.js'));
const { SpintopBattle, PARTICLE_ALPHA_STEPS } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

function mkBattle() {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56;
  b.safeBottom = 24;
  b.start(new Beyblade(0, 1));
  b.countdown = 0;
  return b;
}

/** 记录型 canvas ctx：统计 fillStyle/globalAlpha/arc/fill 的调用，用于断言绘制行为 */
function recCtx() {
  const rec = { fills: [], styleSets: [], arcs: 0, beginPaths: 0, curArcs: 0 };
  let _fs = null;
  const ctx = {
    globalAlpha: 1,
    save() {}, restore() {},
    beginPath() { rec.beginPaths++; rec.curArcs = 0; },
    moveTo() {},
    arc() { rec.arcs++; rec.curArcs++; },
    fill() { rec.fills.push({ style: _fs, alpha: ctx.globalAlpha, arcs: rec.curArcs }); }
  };
  Object.defineProperty(ctx, 'fillStyle', {
    get() { return _fs; },
    set(v) { rec.styleSets.push(v); _fs = v; }
  });
  return { ctx, rec };
}

console.log('\n【P1-5-a】粒子使用自身颜色（旧版被 this.top.color 覆盖）');
{
  const b = mkBattle();
  b.particles.length = 0;
  b._createParticles(b.top.x, b.top.y, 20, '#FFD700');   // 金色（暴击）
  b._createParticles(b.top.x, b.top.y, 20, '#ff5252');   // 红色（打偏）
  const n = b.particles.length;
  ok(`生成了 ${n} 个粒子`, n > 0);

  const { ctx, rec } = recCtx();
  b._drawParticles(ctx);

  const styles = rec.fills.map((f) => f.style);
  ok('金色粒子用 #FFD700 绘制', styles.includes('#FFD700'), styles.join(' / '));
  ok('红色粒子用 #ff5252 绘制', styles.includes('#ff5252'), styles.join(' / '));
  ok('未再把所有粒子统一画成陀螺色', !styles.includes(b.top.color), 'top.color=' + b.top.color);
  ok(`绘制的 arc 数 = 粒子数（${rec.arcs}）`, rec.arcs === n, 'arcs=' + rec.arcs + ' n=' + n);
}

console.log('\n【P1-5-b】粒子按 life 淡出（旧版完全不设 globalAlpha）');
{
  const b = mkBattle();
  b.particles.length = 0;
  b._createParticles(b.top.x, b.top.y, 20, '#FFD700');
  const half = Math.floor(b.particles.length / 2);
  for (let i = 0; i < b.particles.length; i++) {
    b.particles[i].life = i < half ? 1.0 : 0.25;   // 一半满亮、一半将熄
  }

  const { ctx, rec } = recCtx();
  b._drawParticles(ctx);

  const alphas = rec.fills.map((f) => f.alpha);
  ok('存在不满亮的批次（alpha < 1）', alphas.some((a) => a < 1), alphas.join(' / '));
  ok('存在满亮批次（alpha = 1）', alphas.some((a) => a === 1), alphas.join(' / '));
  ok(`alpha 均为 ${PARTICLE_ALPHA_STEPS} 档量化的合法值`,
    alphas.every((a) => a > 0 && a <= 1), alphas.join(' / '));
  ok('life 0.25 的批次 alpha 明显低于 life 1.0 的批次',
    Math.min(...alphas) <= 0.3, 'min=' + Math.min(...alphas));
}

console.log('\n【P1-5-c】分批绘制，没有退化成逐粒子 drawcall');
{
  // 同批粒子颜色相同、life 也接近（真实情况：一次抽打爆出的粒子同时生成、同步衰减）
  const b = mkBattle();
  b.particles.length = 0;
  b._createParticles(b.top.x, b.top.y, 20, '#FFD700');
  const goldN = b.particles.length;
  for (let i = 0; i < goldN; i++) b.particles[i].life = 0.82;
  b._createParticles(b.top.x, b.top.y, 20, '#ff5252');
  for (let i = goldN; i < b.particles.length; i++) b.particles[i].life = 0.45;

  const { ctx, rec } = recCtx();
  b._drawParticles(ctx);

  const n = b.particles.length;
  ok(`共 ${n} 个粒子，只需 ${rec.fills.length} 次 fill()`, rec.fills.length <= 4,
    'fills=' + rec.fills.length);
  ok(`fill 次数远小于粒子数（${rec.fills.length} << ${n}）`, rec.fills.length < n / 3,
    'fills=' + rec.fills.length + ' n=' + n);
}

console.log('\n【P1-5-d】自然衰减下的 drawcall 上界（防止后续改坏）');
{
  const b = mkBattle();
  b.particles.length = 0;
  for (let k = 0; k < 4; k++) {
    b._createParticles(b.top.x, b.top.y, 24, k % 2 ? '#FFD700' : '#ffd54f');
  }
  for (let f = 0; f < 25; f++) b._updateParticles();   // 各自随机衰减 → 最坏情况
  const n = b.particles.length;
  const { ctx, rec } = recCtx();
  b._drawParticles(ctx);

  ok(`${n} 个粒子自然衰减后 fill 次数 ${rec.fills.length}（上界 ≤ 4×${PARTICLE_ALPHA_STEPS}）`,
    rec.fills.length <= 4 * PARTICLE_ALPHA_STEPS, 'fills=' + rec.fills.length);
  ok('仍绘制了全部粒子', rec.arcs === n, 'arcs=' + rec.arcs + ' n=' + n);
}

console.log('\n【P1-5-e】空粒子列表不崩、不改画布状态');
{
  const b = mkBattle();
  b.particles.length = 0;
  const { ctx, rec } = recCtx();
  let threw = null;
  try { b._drawParticles(ctx); } catch (e) { threw = e; }
  ok('空列表不抛错', threw === null, threw && threw.message);
  ok('空列表不产生任何 fill', rec.fills.length === 0, 'fills=' + rec.fills.length);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
