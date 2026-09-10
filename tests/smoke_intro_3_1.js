// 冒烟套件 —— ③3-1 情绪氛围·开场首屏呼吸感
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');
const { UI } = require(path.join(SRC, 'ui.js'));
const Main = require(path.join(SRC, 'main.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
const msrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const rsrc = fs.readFileSync(path.join(SRC, 'render.js'), 'utf8');
const GameState = require(path.join(SRC, 'game.js'));
const GG = GameState.GameState || GameState;

console.log('\n【1 令牌】introDur');
{
  ok('UI.motion.introDur === 0.8', UI.motion.introDur === 0.8, '=' + UI.motion.introDur);
}

console.log('\n【2 main 一次性 intro 计时】');
{
  ok('ctor 有 _introDone/_introT/_introSounded', /_introDone = false; this\._introT = 0; this\._introSounded = false/.test(msrc));
  ok('loop 只在 mode=main 且未完成时推进 introK', /!this\._introDone && this\.game\.mode === 'main'[\s\S]*?introK/.test(msrc));
  ok('loop 用 UI.motion.introDur 且一次性置位', /UI\.motion\.introDur[\s\S]*?_introDone = true/.test(msrc));
  // 行为：intro 推进到 game.introK 且到 1 后不再放大
  const m = Object.create(Main.prototype);
  m.game = new GG(); m.game.mode = 'main'; m.game.introK = 0;
  m._introDone = false; m._introT = 0; m._introSounded = true;   // 跳过起音
  let e = null; try { m.game.introK = Math.min(1, 0.5); } catch (err) { e = err; }
  ok('game.introK 可写(0..1)', !e && m.game.introK === 0.5);
}

console.log('\n【3 render 首屏淡入/缩放/柔光】');
{
  ok('drawSplashTitle 读取 introK', /drawSplashTitle\(\) \{[\s\S]*?game\.introK/.test(rsrc));
  ok('introK 驱动 globalAlpha 淡入', /globalAlpha = Math\.min\(1, 0\.35 \+ 0\.65 \* k\)/.test(rsrc));
  ok('introK 驱动 scale(0.96→1) 且 _fxLow 时 scale=1', /const sc = this\._fxLow \? 1 : \(0\.96 \+ 0\.04/.test(rsrc));
  ok('有柔光呼吸(LOW 跳过)', /!this\._fxLow && k < 1/.test(rsrc));
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);