// 冒烟套件 6 —— P0-2 游戏圈入口（图标可绘制 + 开发者话术不泄露给玩家）
//
// 背景：config.js 的 gameClubOpenlink 为空时，旧代码会向玩家 Toast
// 「请先在后台配置游戏圈 openlink」—— 开发者话术直接暴露给玩家，且入口是死路。
// 现在：未配置则入口按钮不渲染（render.js 胶囊行），玩家看不到也收不到提示。
process.env.TZ = 'Asia/Shanghai';
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { drawVectorIcon } = require(path.join(SRC_DIR, 'utils.js'));
const { CONFIG } = require(path.join(SRC_DIR, 'config.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

// 记录型 mock ctx：drawVectorIcon 只用 Canvas2D 的一小部分 API
function mockCtx() {
  const calls = { stroke: 0, fill: 0, arc: 0, moveTo: 0, lineTo: 0, quad: 0, closePath: 0, save: 0, restore: 0 };
  return {
    calls,
    save() { calls.save++; }, restore() { calls.restore++; },
    beginPath() {}, closePath() { calls.closePath++; },
    moveTo() { calls.moveTo++; }, lineTo() { calls.lineTo++; },
    quadraticCurveTo() { calls.quad++; },
    arc() { calls.arc++; },
    stroke() { calls.stroke++; }, fill() { calls.fill++; },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: ''
  };
}

console.log('\n【P0-2-a】社区矢量图标 club 可绘制（无配套 PNG，纯矢量）');
{
  const ctx = mockCtx();
  let threw = null;
  try { drawVectorIcon(ctx, 'club', 50, 50, 32, '#ffffff'); }
  catch (e) { threw = e; }
  ok('drawVectorIcon("club") 不抛错', threw === null, threw && threw.message);
  ok('绘制了气泡描边（stroke ≥ 1）', ctx.calls.stroke >= 1, 'stroke=' + ctx.calls.stroke);
  ok('绘制了气泡内三个点（arc == 3）', ctx.calls.arc === 3, 'arc=' + ctx.calls.arc);
  ok('save/restore 成对（不泄漏画布状态）', ctx.calls.save === 1 && ctx.calls.restore === 1,
    'save=' + ctx.calls.save + ' restore=' + ctx.calls.restore);
}

console.log('\n【P0-2-b】已知图标回归：coin / more / mute 仍可绘制');
{
  for (const t of ['coin', 'more', 'mute', 'unmute', 'star', 'check']) {
    const ctx = mockCtx();
    let threw = null;
    try { drawVectorIcon(ctx, t, 40, 40, 28, '#ffffff'); }
    catch (e) { threw = e; }
    ok(`drawVectorIcon("${t}") 不抛错`, threw === null, threw && threw.message);
  }
}

console.log('\n【P0-2-c】玩家可见文案不含开发者话术');
{
  const src = fs.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8');
  const toasts = src.match(/this\._toast\(['"]([^'"]*)['"]/g) || [];
  const BANNED = ['配置', 'openlink', 'Openlink', '后台', '占位', 'placeholder', 'TODO', 'adunit'];
  const hits = [];
  for (const t of toasts) {
    for (const w of BANNED) {
      if (t.indexOf(w) !== -1) hits.push(t + '  ← 含「' + w + '」');
    }
  }
  ok(`共 ${toasts.length} 处 _toast 文案，均不含开发者话术`, hits.length === 0, hits.join(' | '));
  ok('_toast 调用点数量合理（>5，说明确实扫到了）', toasts.length > 5, 'n=' + toasts.length);
}

console.log('\n【P0-2-d】未配置 openlink 时入口不渲染（配置门控生效）');
{
  // 门控逻辑：render.js 胶囊行仅在 CONFIG.gameClubOpenlink 非空时 push club 按钮
  const renderSrc = fs.readFileSync(path.join(SRC_DIR, 'render.js'), 'utf8');
  ok('render.js 已引入 CONFIG', /require\(['"]\.\/config['"]\)/.test(renderSrc));
  ok('club 按钮被 CONFIG.gameClubOpenlink 门控', /if \(CONFIG\.gameClubOpenlink\)[\s\S]{0,400}action: 'club'/.test(renderSrc));
  ok('含越界兜底（窄屏不画）', /cRect\.x > 16/.test(renderSrc));
  ok('main.js 已接上 club 动作分发', /a === 'club'/.test(fs.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8')));
  // 当前仓库状态：尚未配置（配置后此项会转红，提醒同步更新说明）
  ok('当前 gameClubOpenlink 为空 → 入口不显示（配好后需更新本断言）', CONFIG.gameClubOpenlink === '',
    'v=' + CONFIG.gameClubOpenlink);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
