// 冒烟套件 21 —— 结算页（失败/胜利）元素垂直布局不重叠
//
// 背景（用户真机反馈）：失败页「再接再厉」被「看广告复活 / 返回」按钮挡住（元素叠加遮挡）；
// 另发现胜利/失败页在「连战」模式下「连战·第N关」会压到奖励胶囊。
// 根因：失败页 noteY 与按钮 Y 用了同一值；连战文案写在分数块内、跨到胶囊区。
// 本套件用 mock canvas 记录 fillText 的 y 与 roundRectPath 的矩形，断言：
//   1) 失败页提示文案严格位于按钮行之上（留呼吸间距，不压按钮）；
//   2) 连战文案（runActive）严格位于按钮行之上，且不落在任一胶囊矩形内。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { SpintopBattle } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 录制式 mock ctx：所有方法 no-op，记录 fillText / roundRectPath / 关键调用计数 */
function makeCtx() {
  const rec = { texts: [], rects: [], strokeCount: 0, radialCount: 0 };
  const base = {};
  ['save','restore','translate','scale','rotate','beginPath','moveTo','lineTo',
   'closePath','arc','arcTo','fill','stroke','fillRect','strokeRect','clip',
   'drawImage','setTransform','clearRect','rect','strokeText'].forEach(m => base[m] = () => {});
  const handler = {
    get(t, p) {
      if (p === '__rec') return rec;
      if (p === 'fillText') return (txt, x, y) => rec.texts.push({ text: String(txt), x, y });
      if (p === 'strokeText') return (txt, x, y) => { rec.strokeCount++; rec.texts.push({ text: String(txt), x, y }); };
      if (p === 'roundRectPath') return (c, x, y, w, h, r) => rec.rects.push({ x, y, w, h });
      if (p === 'measureText') return (txt) => ({ width: String(txt).length * 6 });
      if (p === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (p === 'createRadialGradient') return () => { rec.radialCount++; return { addColorStop() {} }; };
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; }
  };
  return new Proxy(base, handler);
}

function newBattle(result) {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.phase = 'result'; b.result = result;
  b.score = result === 'win' ? 300000 : 120000;
  b.targetScore = 285000;          // 用户提到的目标 28万5
  b.reward = 520; b.arenaGained = 0;
  b.dropItem = null; b.chestDropped = null;
  b.isRingOut = false;
  return b;
}

console.log('\n【结果页-失败】提示文案不压按钮（winStreak=0 → 再接再厉）');
{
  const b = newBattle('lose');
  b.game.winStreak = 0;
  const ctx = makeCtx();
  const btns = b._drawResult(ctx);
  const btnY = Math.min.apply(null, btns.map(r => r.y));
  const note = ctx.__rec.texts.find(t => t.text.indexOf('再接再厉') >= 0);
  ok('记录了「再接再厉」文案', !!note, JSON.stringify(ctx.__rec.texts.map(t => t.text)));
  ok('提示文案严格位于按钮行之上（留呼吸间距）', !!note && (note.y + 12) < btnY,
    note ? `noteY=${note.y.toFixed(0)} btnY=${btnY.toFixed(0)}` : 'no note');
}

console.log('\n【结果页-失败】提示文案不压按钮（winStreak=5 → 连胜中断，再接再厉）');
{
  const b = newBattle('lose');
  b.game.winStreak = 5;
  const ctx = makeCtx();
  const btns = b._drawResult(ctx);
  const btnY = Math.min.apply(null, btns.map(r => r.y));
  const note = ctx.__rec.texts.find(t => t.text.indexOf('再接再厉') >= 0);
  ok('记录了「连胜中断，再接再厉」文案', !!note, JSON.stringify(ctx.__rec.texts.map(t => t.text)));
  ok('提示文案严格位于按钮行之上', !!note && (note.y + 12) < btnY,
    note ? `noteY=${note.y.toFixed(0)} btnY=${btnY.toFixed(0)}` : 'no note');
}

console.log('\n【结果页-胜利·连战】连战文案不压胶囊、也不压按钮');
{
  const b = newBattle('win');
  b.runActive = true; b.runStage = 3;
  const ctx = makeCtx();
  const btns = b._drawResult(ctx);
  const btnY = Math.min.apply(null, btns.map(r => r.y));
  const run = ctx.__rec.texts.find(t => t.text.indexOf('连战') >= 0);
  const chips = ctx.__rec.rects.filter(r => Math.abs(r.h - 28) < 0.5); // 奖励胶囊高 28（B 档 CHIP_H）
  ok('记录了「连战·第N关」文案', !!run, JSON.stringify(ctx.__rec.texts.map(t => t.text)));
  const onChip = chips.some(c => run && run.y >= c.y - 2 && run.y <= c.y + c.h + 2);
  ok('连战文案不落在任一胶囊矩形内', !!run && !onChip,
    run ? `runY=${run.y.toFixed(0)} chips=[${chips.map(c => c.y.toFixed(0) + '..' + (c.y + c.h).toFixed(0)).join(', ')}]` : 'no run');
  ok('连战文案位于按钮行之上', !!run && (run.y + 12) < btnY,
    run ? `runY=${run.y.toFixed(0)} btnY=${btnY.toFixed(0)}` : 'no run');
}

console.log('\n【结果页-失败】能量模块：目标行在能量卡之上、数值/扣除/能量条齐全');
{
  const b = newBattle('lose');
  b.game.winStreak = 0;
  b.game.energy = 120; b.game.maxEnergy = 150;   // 模拟战败后剩余能量
  const ctx = makeCtx();
  b._drawResult(ctx);
  const target = ctx.__rec.texts.find(t => t.text.indexOf('目标') >= 0);
  const energyLbl = ctx.__rec.texts.find(t => t.text.indexOf('能量 ') >= 0 && t.text.indexOf('/') >= 0);
  const penalty = ctx.__rec.texts.find(t => t.text.indexOf('−15') >= 0);
  ok('记录了「目标 …」文案', !!target);
  ok('记录了「能量 当前/上限」文案', !!energyLbl, JSON.stringify(ctx.__rec.texts.map(t => t.text)));
  ok('能量文案显示当前值 120/150', !!energyLbl && energyLbl.text === '能量 120/150', energyLbl && energyLbl.text);
  // P2 细度（2026-10-31）：战败惩罚停用 → 结算页不再渲染「−N」扣能文案；反向断言防回退
  ok('已停用：结算页不再出现「−15」扣能文案', !penalty);
  ok('能量文案仍在（当前/上限展示保留）', !!energyLbl,
    energyLbl && penalty ? `lblY=${energyLbl.y.toFixed(0)} penY=${penalty.y.toFixed(0)}` : 'missing');
  ok('目标行严格位于能量模块之上（不重叠、留呼吸 ≥20px）',
    !!target && !!energyLbl && (energyLbl.y - target.y) >= 20,
    target && energyLbl ? `targetY=${target.y.toFixed(0)} energyY=${energyLbl.y.toFixed(0)} gap=${(energyLbl.y - target.y).toFixed(0)}` : 'missing');
}

console.log('\n────────────────────────');

console.log('\n【结果页·游戏化】标题描边 + 氛围底图（胜利射线 / 失败暗角）已接入');
{
  // 失败页：标题描边 + 红色径向暗角
  const b = newBattle('lose');
  const ctx = makeCtx();
  b._drawResult(ctx);
  ok('失败页对标题做了描边（strokeText≥1）', ctx.__rec.strokeCount >= 1, 'strokeCount=' + ctx.__rec.strokeCount);
  ok('失败页绘制了暗角氛围底图（createRadialGradient≥1）', ctx.__rec.radialCount >= 1, 'radialCount=' + ctx.__rec.radialCount);

  // 胜利页：标题描边 + 金色径向光晕
  const b2 = newBattle('win');
  const ctx2 = makeCtx();
  b2._drawResult(ctx2);
  ok('胜利页对标题做了描边（strokeText≥1）', ctx2.__rec.strokeCount >= 1, 'strokeCount=' + ctx2.__rec.strokeCount);
  ok('胜利页绘制了光晕氛围底图（createRadialGradient≥1）', ctx2.__rec.radialCount >= 1, 'radialCount=' + ctx2.__rec.radialCount);
}

console.log('\n【结果页·粒子】结算粒子层不崩溃且被消费');
{
  const b = newBattle('win');
  b._resultParticles = [
    { x: 100, y: 200, vy: -1, rotation: 0, rotSpeed: 0.02, alpha: 0.8, size: 4, color: '#ffd54f', type: 'star' },
    { x: 300, y: 400, vy: -1, rotation: 0, rotSpeed: 0.02, alpha: 0.6, size: 3, color: '#fff', type: 'dot' },
    { x: 200, y: 300, vy: -1, rotation: 0, rotSpeed: 0.02, alpha: 0.5, size: 5, color: '#ffca28', type: 'shard' }
  ];
  const ctx = makeCtx();
  let crashed = false;
  try { b._drawResult(ctx); } catch (e) { crashed = true; console.log('   err=' + e.message); }
  ok('带 3 个粒子时 _drawResult 不抛异常', !crashed);
}

console.log('\n────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
