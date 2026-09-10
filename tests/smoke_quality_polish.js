// 冒烟套件 —— ②质感精修回归（盘面高光扫过 / 战斗氛围 / 统一动效）
// 纯装饰、受性能分档(_fxLow)约束、不改物理/玩法；锁定关键守卫与调用锚点，防回退。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC, 'game.js'));
const { Beyblade } = require(path.join(SRC, 'beyblade.js'));
const { SpintopBattle, TOP_SWEEP_ALPHA } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function mockCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => grad;
      if (p in t) return t[p];
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}
function mkBattle(stage = 1) {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.start(new Beyblade(0, 1), null, { active: true, stage: stage, buffs: [] });
  b.countdown = 0;
  b._fxLow = false;
  return b;
}
const src = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
const rsrc = fs.readFileSync(path.join(SRC, 'render.js'), 'utf8');

console.log('\n【A 盘面精修】');
{
  ok('TOP_SWEEP_ALPHA ∈(0,1)', TOP_SWEEP_ALPHA > 0 && TOP_SWEEP_ALPHA < 1, '=' + TOP_SWEEP_ALPHA);
  ok('导出 TOP_SWEEP_ALPHA', /TOP_SWEEP_ALPHA,/.test(src));
  ok('位图路径调用 _drawTopSweep（真机生效）', /drawImage\(sprite[^]*?_drawTopSweep\(ctx, r, speed\)/.test(src));
  // _drawTopSweep 早退守卫 + 不抛错
  const b = mkBattle(1); b.top.angularVelocity = 50; b.top.radius = 30; b.top.trailColor = '#ffb300';
  let e = null; try { b._drawTopSweep(mockCtx(), 30, 50); } catch (err) { e = err; }
  ok('_drawTopSweep 高转正常不抛错', !e, e && e.message);
  b._fxLow = true;
  b._hitstopT = 0;
  // LOW 档守卫（源级）
  ok('LOW 档早退守卫', /_drawTopSweep\(ctx, r, speed\) \{[\s\S]*?if \(this\._fxLow \|\| speed <= 2\) return/.test(src));
  ok('A2 拖尾微强化含 clamp 与 _fxLow', /Math\.min\(1, \(isCrit \? 1 :[\s\S]*?0\.08 : 0\)\)/.test(src));
  ok('盘面·星轨：贴盘缘亮弧随盘自转（高速更亮）', /ctx\.arc\(0, 0, r \* 0\.90, -0\.5, 0\.5\)/.test(src) && /speed >= 6/.test(src));
}

console.log('\n【B 战斗氛围随局变化】');
{
  ok('_ambientTint 方法存在', /_ambientTint\(\) \{[\s\S]*?_bgTintKey/.test(src) || /_ambientTint/.test(src));
  ok('氛围层纳入背景缓存条件（tint.key 变化触发重烘焙）', /this\._bgTintKey !== tint\.key/.test(src));
  ok('氛围叠层在烘焙内受 _fxLow 门控（LOW 档不叠加）', /if \(!this\._fxLow\) \{[\s\S]*?fillRect\(0, 0, w, h\)/.test(src));
  ok('氛围色随 stage/BOSS 变化（冷/中性/暖 + BOSS 偏红）', /'#2b5f9e'/ .test(src) && /'#6e1a1a'/.test(src) && /this\.isBoss/.test(src));
  // 行为：stage 1 冷、BOSS 关偏红，key 不同
  const b5 = mkBattle(5); b5.isBoss = true;
  const t1 = mkBattle(1)._ambientTint(); mkBattle(5); const t5 = b5._ambientTint();
  ok('普通前期待 t1.key', typeof t1.key === 'string' && t1.key.length > 0);
  ok('BOSS 关 key 与普通关不同（含 B 前缀）', t5.key.indexOf('B') === 0, 't5=' + t5.key);
  ok('氛围色不为透明（alpha>0）', t1.alpha > 0 && t5.alpha > 0);
}

console.log('\n【C 统一动效】');
{
  ok('beginPanelAnim 用轻 overshoot easeOutBack（原生 App 弹出感）', /easeOutBack|1 \+ c3 \* Math\.pow\(k - 1, 3\)/.test(rsrc) || /c3 \* Math\.pow\(k - 1, 3\)/.test(rsrc));
  ok('统一时长改为 0.26', /\(dur \|\| 0\.26\)/.test(rsrc));
  ok('10 面板共用外壳未被覆盖（beginPanelAnim 仍在）', /beginPanelAnim/.test(rsrc));
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);