// 烟雾测试：8.0→9.0 三大件门禁（2026-11-24 · 花叔范式 01/07/08）
// A. HUD 融入世界：金币=矿石计量槽（切角+余烬） / 能量条=炉温计（炉火渐变）
// B. 陀螺即角色：待机旋转跟随炉温 + 连胜火星拖尾 + 出炉金环余晖
// C. 战报分享卡：离屏 canvas 动态生成本局战绩图（GameDigits + 失败回落静态图）
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

const rsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
const ssrc = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
const msrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const usrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');

console.log('【A】HUD 融入世界（矿石槽 + 炉温计）');
ok('金币=矿石计量槽（金属切角槽体 _orePath）', /_orePath/.test(rsrc) && /余烬底光/.test(rsrc));
ok('矿石槽命中区零改动（无 coinRect 新增，仍走 coinX/coinW 原几何）', /const coinW = coinPad \* 2 \+ coinIcon \+ coinGap \+ coinTxtW;/.test(rsrc));
ok('能量条→炉温计（炉火升温渐变）', /炉温渐变/.test(rsrc) && /炉子冷了：只剩暗红余烬/.test(rsrc));
ok('低能量警告保留（文字脉冲）', /lowEnergy = p < 0\.3/.test(rsrc));
ok('金币数字走 GameDigits 嗓音', /bold 15px ' \+ UI\.familyDigit/.test(rsrc));

console.log('【B】陀螺即角色（待机姿态三态）');
ok('① 待机旋转跟随炉温（满2.6/正常1.8/低0.7 rad·s⁻¹）', /_spin = _hp >= 1 \? 2\.6 : \(_hp >= 0\.3 \? 1\.8 : 0\.7\)/.test(rsrc));
ok('② 连胜火星拖尾（≥2 冒火星 / ≥4 加金粒，低频 260ms）', /winStreak \|\| 0\) >= 2 && _nowMs - \(this\._flameT \|\| 0\) > 260/.test(rsrc));
ok('③ 出炉金环余晖（合成 1.2s 内，_glowT）', /_glowT && _nowMs - bb\._glowT < 1200/.test(rsrc));
ok('main 合成时写 _glowT', /merged\._glowT = Date\.now\(\)/.test(msrc));

console.log('【C】战报分享卡（离屏 canvas 动态生成）');
ok('main 定义 _makeResultShareImage（500×400 离屏 canvas）', /_makeResultShareImage\(done\)[\s\S]{0,400}createCanvas/.test(msrc));
ok('导出走 wx.canvasToTempFilePath', /canvasToTempFilePath\(\{[\s\S]*?canvas: c/.test(msrc));
ok('大分数用 GameDigits（数字嗓音）', /bold 72px GameDigits, sans-serif/.test(msrc));
ok('失败回落静态 shareCardImage', /imageUrl: imageUrl \|\| CONFIG\.shareCardImage/.test(msrc));
ok('离屏 canvas 复用（_shareCvs 不重复建组件）', /if \(!this\._shareCvs\) this\._shareCvs = wx\.createCanvas\(\)/.test(msrc));

console.log('【附带】语义色词典成文（ui.js）');
ok('ui.js 语义色词典（gold=货币荣耀 / ink=文字层级）', /语义色词典/.test(usrc) && /ink: \{/.test(usrc));

console.log(`\n[world-role] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
