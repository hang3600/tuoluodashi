// 冒烟套件 —— ③3-3 图标单色系统一：icon 令牌 + drawIconButton 统一描边
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');
const { UI } = require(path.join(SRC, 'ui.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
const rsrc = fs.readFileSync(path.join(SRC, 'render.js'), 'utf8');

console.log('\n【1 icon 令牌】');
{
  ok('UI.icon 含 glyph/stroke/weight', UI.icon && typeof UI.icon.glyph === 'string' && typeof UI.icon.stroke === 'string' && typeof UI.icon.weight === 'number');
  ok('glyph 为纯白 #ffffff（单色白图形）', UI.icon.glyph === '#ffffff');
  ok('weight ∈[1,2]（统一描边粗细）', UI.icon.weight >= 1 && UI.icon.weight <= 2);
}

console.log('\n【2 render 图标按钮统一描边取令牌】');
{
  ok('drawIconButton 描边取 UI.icon.stroke（按下态=ink.body 令牌，评审归一 2026-11-22）', /ctx\.strokeStyle = pressed \? UI\.color\.ink\.body : UI\.icon\.stroke/.test(rsrc));
  ok('drawIconButton 描边粗细取 UI.icon.weight', /ctx\.lineWidth = UI\.icon\.weight/.test(rsrc));
  ok('矢量回退取 UI.icon.glyph(白)', /drawVectorIcon\(ctx, iconType,[\s\S]*?UI\.icon\.glyph/.test(rsrc));
  ok('注释标记 ③3-3 统一描边', /③3-3 统一描边/.test(rsrc));
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);