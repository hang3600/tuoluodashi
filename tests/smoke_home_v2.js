// 冒烟套件 23 —— 主界面游戏化骨架（V2）布局 + 视觉语言 + 交互锁定
//
// 背景（整体审计 #1）：旧主界面是「顶部资源栏 + 大标题/Tab + 内容 + 底部等宽工具栏」的
// 小程序三段式骨架。V2 改为游戏化：
//   ① 顶栏更薄（HUD 化）  ② 去掉「游戏名+副标题」大标题区（只留视图切换条）
//   ③ 省出的纵向空间让给 Arena 圆盘  ④ 行动栏改为异形主钮 + 次钮
//   ⑤ 合成台升级为「锻造工坊」（熔炉光晕 + 能量汇聚 + 金属锻造环 + 铆钉）—— 换"皮"的关键
// 并存开关：game.homeV2 = false 完整回退旧大厅。
//
// 本套件锁定：
//   1) V2 标题区显著缩小、圆盘不小于旧版、三种机型均不越安全区；
//   2) drawViewTabs 注册切换命中区 + 保留「任务」入口（去标题不丢功能）；
//   3) drawHomeActions 四个一致性按钮（等宽等分）+ 四命中区齐全 + 按下态生效 + 引导 rect 已存；
//   4) drawForgeV2 绘制装饰后仍注册 3 个合成台槽位命中区（交互零改动）；
//   5) 回退开关 homeV2 = false 恢复旧三段式。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');
const { Renderer } = require(path.join(SRC, 'render.js'));
const { GameState } = require(path.join(SRC, 'game.js'));
const { Beyblade } = require(path.join(SRC, 'beyblade.js'));
const Main = require(path.join(SRC, 'main.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 无头 Canvas2D 桩：记录 save/restore 深度，gradient 返回桩 */
function makeCtx() {
  let depth = 0;
  const self = {};
  const handler = {
    get(t, p) {
      if (p === 'save') return () => { depth++; };
      if (p === 'restore') return () => { depth--; if (depth < 0) throw new Error('restore 下溢'); };
      if (p === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (p === 'canvas') return { width: 390, height: 844 };
      if (p === 'getDepth') return () => depth;
      if (p in self) return self[p];
      return function () {};
    },
    set(t, p, v) { self[p] = v; return true; }
  };
  return new Proxy({}, handler);
}

function mkRenderer(game, w, h) {
  Renderer.prototype._loadIcons = function () {};   // 跳过真实 PNG 加载
  const r = new Renderer({ width: w, height: h }, makeCtx(), game, 56, 24,
    { left: 350, top: 10, width: 87, height: 32 });
  r.shadowScale = 1;
  r._reflow();
  return r;
}

function layoutOf(v2, w, h) {
  const g = new GameState();
  g.homeV2 = v2;
  return mkRenderer(g, w, h).layout;
}

console.log('\n【V2 骨架】标题区缩小、圆盘放大、三种机型不越安全区');
{
  const cases = [
    ['iPhone14', 390, 844],
    ['iPhoneSE', 375, 667],
    ['Android-narrow', 360, 640]
  ];
  for (const [name, w, h] of cases) {
    const A = layoutOf(true, w, h);
    const B = layoutOf(false, w, h);
    ok(name + ' 标题区显著缩小（去掉大标题）', A.titleH < B.titleH - 20,
      'V2=' + A.titleH + ' 旧=' + B.titleH);
    ok(name + ' 圆盘不小于旧版', A.arenaH >= B.arenaH - 0.5,
      'V2=' + Math.round(A.arenaH) + ' 旧=' + Math.round(B.arenaH));
    ok(name + ' 顶栏更薄（HUD 化）', A.topBarH <= B.topBarH,
      'V2=' + A.topBarH + ' 旧=' + B.topBarH);
    const invBottom = A.invY + (A.invCell + A.invGap) * 2;
    ok(name + ' 不越安全区（顶/底/与行动栏）',
      A.arenaY >= 56 && A.tabY >= 56 && invBottom <= h - 24 && (A.arenaY + A.arenaH) <= A.actionY,
      'arenaY=' + Math.round(A.arenaY) + ' tabY=' + Math.round(A.tabY) +
      ' invBottom=' + Math.round(invBottom) + '/' + (h - 24));
  }
}

console.log('\n【V2 视图切换条】命中区注册 + 任务入口不丢失');
{
  const g = new GameState();
  g.homeV2 = true;
  const r = mkRenderer(g, 390, 844);
  r.tabRects = [];
  r.buttons = [];
  let threw = null;
  try { r.drawViewTabs(); } catch (e) { threw = e.message; }
  ok('drawViewTabs 不抛异常', !threw, threw);
  ok('注册了 2 个视图切换命中区（合成/图鉴）', r.tabRects.length === 2, 'n=' + r.tabRects.length);
  const views = r.tabRects.map(t => t.view).sort().join(',');
  ok('切换区包含 main 与 codex', views === 'codex,main', views);
  ok('保留了「任务」入口按钮（去标题不丢功能）', !!r.buttons.find(b => b.action === 'daily'));
  ok('save/restore 平衡', r.ctx.getDepth() === 0, 'depth=' + r.ctx.getDepth());
}

console.log('\n【V2 行动栏】四个一致性按钮（等宽等分）+ 命中区 + 按下态');
{
  const g = new GameState();
  g.homeV2 = true;
  const r = mkRenderer(g, 390, 844);
  r.buttons = [];
  r.pressedBtn = null;
  let threw = null;
  try { r.drawHomeActions(); } catch (e) { threw = e.message; }
  ok('drawHomeActions 不抛异常', !threw, threw);
  const acts = r.buttons.map(b => b.action).sort().join(',');
  ok('注册了四个命中区（battle_quick 对战 + merge 合成 + draw 抽卡 + buff 增益）',
    acts === 'battle_quick,buff,draw,merge', acts);
  ok('主按钮为 battle_quick（#11 一键开战，跳过增益面板）',
    r.battleBtnRect.action === 'battle_quick', 'action=' + r.battleBtnRect.action);
  ok('增益为独立 buff 入口（点了才开增益面板）',
    !!r.buttons.find(b => b.action === 'buff'));
  ok('四个按钮等宽（一致性：去掉主次大小之分）',
    r.battleBtnRect.w === r.mergeBtnRect.w && r.mergeBtnRect.w === r.drawBtnRect.w,
    '对战=' + r.battleBtnRect.w + ' 合成=' + r.mergeBtnRect.w + ' 抽卡=' + r.drawBtnRect.w);
  ok('引导定位用 rect 已存（新手引导高亮不失效）',
    !!r.battleBtnRect && !!r.mergeBtnRect && !!r.drawBtnRect);
  // 四个按钮（主钮 + 合成/抽卡 + 增益）横向排布：不越界、不重叠
  const all = r.buttons.slice().sort((a, b) => a.x - b.x);
  let inBounds = true, noOverlap = true, geom = '';
  for (let i = 0; i < all.length; i++) {
    if (all[i].x < 8 || all[i].x + all[i].w > 390 - 8) inBounds = false;
    if (i > 0 && all[i].x < all[i - 1].x + all[i - 1].w) noOverlap = false;
    geom += Math.round(all[i].x) + '+' + Math.round(all[i].w) + ' ';
  }
  ok('四个按钮均在屏幕内（不越界）', inBounds, geom.trim());
  ok('四个按钮互不重叠', noOverlap, geom.trim());
  // 按下态：命中 rect 与 action 匹配时不崩（按下会走 0.94 缩放 + 暗化分支）
  r.pressedBtn = { rect: { action: 'battle_quick' }, t0: Date.now() };
  let threw2 = null;
  try { r.drawHomeActions(); } catch (e) { threw2 = e.message; }
  ok('按下态（battle_quick 主钮）绘制不崩', !threw2, threw2);
  r.pressedBtn = null;
  ok('save/restore 平衡', r.ctx.getDepth() === 0, 'depth=' + r.ctx.getDepth());
}

console.log('\n【V2 锻造台】装饰绘制后合成台槽位命中区不丢失');
{
  const g = new GameState();
  g.homeV2 = true;
  const r = mkRenderer(g, 390, 844);
  r.platformRects = [];
  let threw = null;
  try { r.drawForgeV2(0.016); } catch (e) { threw = e.message; }
  ok('drawForgeV2 不抛异常', !threw, threw);
  ok('仍注册 3 个合成台槽位命中区（交互零改动）', r.platformRects.length === 3,
    'n=' + r.platformRects.length);
  ok('save/restore 平衡', r.ctx.getDepth() === 0, 'depth=' + r.ctx.getDepth());

  // 无圆盘（防御分支）时应退化为原 drawPlatform，不崩
  r.platformRects = [];
  r.layout.arenaR = 0;
  let threw0 = null;
  try { r.drawForgeV2(0.016); } catch (e) { threw0 = e.message; }
  ok('arenaR=0 防御分支不崩', !threw0, threw0);
}

console.log('\n【#11 首屏可玩】一键开战：主按钮直达战斗，跳过局前增益面板');
{
  // Main 构造很重（canvas / wx / sysInfo），用裸实例只挂 _quickBattle 所需字段
  const mk = (beyblade) => {
    const m = Object.create(Main.prototype);
    const spy = { confirm: 'NOT_CALLED', toast: null };
    m.game = { selectBattleBeyblade: () => beyblade, buffBb: null };
    m._toast = (s) => { spy.toast = s; };
    m._confirmBattleBuff = (b) => { spy.confirm = b; };
    return { m, spy };
  };
  // 有陀螺：应直接以 null（不带增益）开战，且先设好 buffBb
  const bb = new Beyblade(0, 1);
  const a = mk(bb);
  let threw = null;
  try { a.m._quickBattle(); } catch (e) { threw = e.message; }
  ok('_quickBattle 不抛异常', !threw, threw);
  ok('一键开战直接调用 _confirmBattleBuff(null)（跳过增益面板）',
    a.spy.confirm === null, 'arg=' + String(a.spy.confirm));
  ok('一键开战已设好出战陀螺 buffBb', a.m.game.buffBb === bb);
  // 无陀螺：给出提示且不开战
  const b0 = mk(null);
  b0.m._quickBattle();
  ok('无陀螺时提示而非开战', b0.spy.toast === '先抽卡或合成一个陀螺', 'toast=' + b0.spy.toast);
  ok('无陀螺时不调用开战流程', b0.spy.confirm === 'NOT_CALLED', 'arg=' + String(b0.spy.confirm));
}

console.log('\n【一致性】增益为独立入口，主按钮恒 battle_quick（不受 quick 开关影响）');
{
  const g = new GameState();
  g.homeV2 = true;
  g.quickBattleV2 = false;
  const r = mkRenderer(g, 390, 844);
  ok('quickBattleV2On() 为 false', r.quickBattleV2On() === false);
  r.buttons = [];
  r.pressedBtn = null;
  let threw = null;
  try { r.drawHomeActions(); } catch (e) { threw = e.message; }
  ok('绘制不崩', !threw, threw);
  ok('主按钮仍为 battle_quick（直接开战，增益交独立按钮）',
    r.battleBtnRect.action === 'battle_quick', 'action=' + r.battleBtnRect.action);
  ok('增益独立 buff 按钮始终显示',
    r.buttons.filter(b => b.action === 'buff').length === 1,
    'n=' + r.buttons.filter(b => b.action === 'buff').length);
}

console.log('\n【回退开关】homeV2 = false 走旧大厅三段式');
{
  const g = new GameState();
  g.homeV2 = false;
  const B = mkRenderer(g, 390, 844).layout;
  ok('回退后标题区恢复（大标题区回来了）', B.titleH > 60, 'titleH=' + B.titleH);
  ok('回退后行动按钮为旧高度', B.actionBtnH === 40, 'h=' + B.actionBtnH);
}

console.log('\n────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
