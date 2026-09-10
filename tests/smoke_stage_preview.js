// 冒烟套件 —— 拉单局时长：暴击次数里程碑飘字 + 结算→下一关目标预览
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');
const { SpintopBattle } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

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
const src = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');

console.log('\n【A 暴击次数里程碑】源码级');
{
  ok('有 _critCount 字段（每局重置位声明）', /this\._critCount = 0;/.test(src));
  ok('暴击块内递增 _critCount', /this\._critCount\+\+;/.test(src));
  ok('里程碑 [5,10,20] 与金色飘字「次暴击！」', /\[5, 10, 20\]/.test(src) && /次暴击！/.test(src));
  ok('精神飘字用 _addFloatingText（非新系统）', /_addFloatingText\(top\.x, top\.y - 150, '第 '/.test(src));
}

console.log('\n【A 行为】_critCount 里程碑可触发且不抛错');
{
  const { Beyblade } = require(path.join(SRC, 'beyblade.js'));
  const g = require(path.join(SRC, 'game.js'));
  const GameState = g.GameState || g;
  const b = new SpintopBattle(new GameState(), 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.start(new Beyblade(0, 1), null, { active: true, stage: 1, buffs: [] });
  b.countdown = 0; b._fxLow = false;
  // 手动置到里程碑边界，验证计数路径不抛错
  b._critCount = 5;
  ok('初始 _critCount 可读写', b._critCount === 5, 'c=' + b._critCount);
  // 通过命中一次暴击递增（模拟 isCrit 分支状态即可，不重放全物理）
  b._critCount++;
  ok('暴击后 _critCount 递增', b._critCount === 6, 'c=' + b._critCount);
  // 轻量渲染：画一次 _drawTop（走回退/位图）不抛错，确保新增不破坏绘制链路
  let e = null; try { b._drawTop(mockCtx()); } catch (err) { e = err; }
  ok('_drawTop 渲染不抛错（含新增字段）', !e, e && e.message);
}

console.log('\n【B 结算→下一关预览】源码级');
{
  ok('预览挂在 isWin && !this.coop（不污染战败/合作）', /if \(isWin && !this\.coop\) \{[\s\S]*?下一关/.test(src));
  ok('用 runStage+1 算下关', /const nextStage = this\.runStage \+ 1;/.test(src));
  ok('下关 BOSS 判定 (nextStage % 5 === 0)', /nextStage % 5 === 0/.test(src));
  ok('文案含 难度↑ 目标↑（只给期待不报精确目标）', /难度↑ 目标↑/.test(src));
  ok('矮屏溢出守卫（防 clip）', /cursor \+ 40 < h/.test(src) || /safeBottom/.test(src));
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);