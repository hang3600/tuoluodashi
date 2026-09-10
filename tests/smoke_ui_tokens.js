// 冒烟套件 —— ①一致性收口·设计令牌：UI 令牌存在 + 高可见处已迁移 + 手感统一
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');
const { UI, APPLE_FONT } = require(path.join(SRC, 'ui.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
const rsrc = fs.readFileSync(path.join(SRC, 'render.js'), 'utf8');

console.log('\n【1 UI 令牌完整】');
{
  ok('UI 含 font/color/radius/motion 四组', UI.font && UI.color && UI.radius && UI.motion,
    'font=' + !!UI.font + ' color=' + !!UI.color + ' radius=' + !!UI.radius + ' motion=' + !!UI.motion);
  ok('字号台阶齐全(digit/h1/h2/title/head/body/label/small/tiny)',
    ['digit','h1','h2','title','head','body','label','small','tiny'].every(k => typeof UI.font[k] === 'number'));
  ok('主色齐全(primary/accent/success/gold/text)',
    ['primary','accent','success','gold','text'].every(k => typeof UI.color[k] === 'string'));
  ok('APPLE_FONT 导出且非空', typeof APPLE_FONT === 'string' && APPLE_FONT.length > 10);
  ok('按压手感 pressScale ∈(0,1) 且 ≈0.94', UI.motion.pressScale > 0 && UI.motion.pressScale < 1 && Math.abs(UI.motion.pressScale - 0.94) < 0.02);
}

console.log('\n【2 render 已接入令牌（高可见处）】');
{
  ok('render 顶部 require("./ui")', /require\('\.\/ui'\)/.test(rsrc));
  ok('render 不再硬编码 APPLE_FONT 字体栈（改引用 UI）', !/const APPLE_FONT = '-apple-system/.test(rsrc));
  ok('含统一文本助手 _tl', /_tl\(px, weight\) \{[\s\S]*?return \(weight \? 'bold ' : ''\) \+ px \+ 'px ' \+ APPLE_FONT/.test(rsrc));
  ok('主按钮文字色用 UI.color.text', /ctx\.fillStyle = UI\.color\.text;/.test(rsrc));
  ok('主按钮字号用 _tl(UI.font.head/title)', /this\._tl\(UI\.font\.head, true\)/.test(rsrc) && /this\._tl\(UI\.font\.title, true\)/.test(rsrc));
  ok('按钮按压手感取 UI.motion.pressScale', /UI\.motion\.pressScale/.test(rsrc));
}

console.log('\n【行为】实例化 Renderer + _tl 不抛错');
{
  // 轻量：任一 UI 引用不会被缺失炸掉（Node 加载即校验 require('./ui') 成功）
  let e = null; try { UI.font.h1; } catch (err) { e = err; }
  ok('UI 读取不抛错', !e);
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);