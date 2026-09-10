// 冒烟套件 —— ②细节手感·阶段2-1：触感脉冲 + 飘字节奏统一
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
const ssrc = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');

console.log('\n【1 令牌】motion 增 飘字节奏 + 触感');
{
  ok('motion.floatRise/floatLife 为数字', typeof UI.motion.floatRise === 'number' && typeof UI.motion.floatLife === 'number');
  ok('motion.hapticWin/hapticIn 为字符串(medium/light)', typeof UI.motion.hapticWin === 'string' && typeof UI.motion.hapticIn === 'string');
}

console.log('\n【2 main 触感 _haptic + 挂钩】');
{
  ok('存在 _haptic(kind) 且守护 wx', /_haptic\(kind\) \{[\s\S]*?typeof wx === 'undefined' \|\| !wx\.vibrateShort/.test(msrc));
  ok('胜利结算挂 _haptic(\'win\')', /battle\.result === 'win'\) \{[\s\S]*?_haptic\('win'\)/.test(msrc));
  ok('结算翻倍 onReward 挂 _haptic(\'win\')', /_resultDoubled = true;[\s\S]*?_haptic\('win'\)/.test(msrc));
  // 行为：无 wx 时 _haptic 不抛错
  const m = Object.create(Main.prototype);
  let e = null; try { m._haptic('win'); } catch (err) { e = err; }
  ok('无 wx 时 _haptic 不抛错', !e);
}

console.log('\n【3 render 飘字节奏取 token + spintop 里程碑触感】');
{
  ok('render addFloatText 取 UI.motion.floatRise', /f\.y -= dt \* UI\.motion\.floatRise/.test(rsrc));
  ok('spintop 暴击里程碑轻震(wx 守护)', /第 ' \+ this\._critCount \+ ' 次暴击！'[\s\S]*?wx\.vibrateShort/.test(ssrc));
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);