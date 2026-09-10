// 冒烟套件 —— 皮肤/外观：大师限定盘面持久化 + 渲染（终局奖品落地）
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC, 'game.js'));
const { Beyblade } = require(path.join(SRC, 'beyblade.js'));
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
const gsrc = fs.readFileSync(path.join(SRC, 'game.js'), 'utf8');
const ssrc = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
const msrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');

console.log('\n【A1 持久化】_masterSkin 可选字段');
{
  ok('save 序列化 _masterSkin', /_masterSkin: this\._masterSkin \? 1 : 0,/.test(gsrc));
  ok('sig 含 _masterSkin', /this\.codexClaimed, this\._masterSkin \? 1 : 0,/.test(gsrc));
  ok('load 还原 default(老档 false)', /this\._masterSkin = !!data\._masterSkin;/.test(gsrc));
  ok('migrate 默认 false', /_masterSkin !== 'boolean'\) migrated\._masterSkin = false;/.test(gsrc));
}

console.log('\n【A1-A3 行为】全图鉴 25 档领奖解锁大师限定');
{
  const g = new GameState();
  // 老档无字段 → 默认 false
  const g2 = new GameState(); g2.load({});
  ok('老档 load 后 _masterSkin=false', g2._masterSkin === false, '=' + g2._masterSkin);
  // 填满图鉴(25 解锁) 且已领 5/10/15/20 → claimCodexStage 领 25 档(全图鉴·大师)
  for (let i = 0; i < 25; i++) g.collection.push({ tierIndex: 0, level: 1, unlocked: true });
  g.codexClaimed = 20;   // 已领到 20 档，下一可领 = 25
  const st = g.claimCodexStage();
  ok('领 25 档(全图鉴·大师)返回非空', st && st.n === 25, 'n=' + (st && st.n));
  ok('领奖后 _masterSkin=true（解锁大师限定）', g._masterSkin === true, '=' + g._masterSkin);
}

console.log('\n【A2 渲染】大师限定盘面（源级 + 不抛错）');
{
  ok('_drawTop 含大师金虹缘 rgba(255,214,130', /rgba\(255,214,130/.test(ssrc));
  ok('外光圈受 _fxLow 削减（LOW 只留细缘）', /if \(!this\._fxLow\) \{[\s\S]*?rgba\(255,210,120/.test(ssrc));
  ok('仅在 _masterSkin=true 时渲染', /this\.game && this\.game\._masterSkin/.test(ssrc));
  // 行为：构造战斗，_masterSkin=true，_drawTop 不抛错（走回退路径）
  const g3 = new GameState(); g3._masterSkin = true;
  const b = new SpintopBattle(g3, 375, 812); b.safeTop = 56; b.safeBottom = 24;
  b.start(new Beyblade(0, 1), null, { active: true, stage: 1, buffs: [] }); b.countdown = 0; b._fxLow = false;
  let e = null; try { b._drawTop(mockCtx()); } catch (err) { e = err; }
  ok('_masterSkin=true 时 _drawTop 不抛错', !e, e && e.message);
}

console.log('\n【既有闭环锁定】A3解锁反馈 + B合成动效已在（不重复）');
{
  ok('codex_claim 领奖文案含「全图鉴限定皮肤」', /· 全图鉴限定皮肤/.test(msrc));
  ok('合成成功已有双环冲击波动效', /双环冲击波/.test(msrc));
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);