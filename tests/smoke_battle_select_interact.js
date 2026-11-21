// 批次F·出战陀螺选择面板「交互链路」门禁（2026-09-12 新增，同日修复后重写）
//
// 背景（血泪）：真机投诉「面板出来了，但点哪都是直接开战；关闭X/上一页/下一页/开始对战 全无反应」。
// 根因**不是**按钮没注册、**不是** hitTest 错、**不是**分发分支写错——而是：
//   render.js 的 beginPanelAnim(t)：ease(k)=1+c3*(k-1)^3+c1*(k-1)^2（c1=1.03、c3=c1+1=2.03），scale=sFrom+(1-sFrom)*ease。
//   t=0 → k=0 → ease=0 → **scale=sFrom=0.84、globalAlpha=0.4**：面板被画成 84% 尺寸 + 半透明；
//   而 modalRects 是按 1.0 布局注册的。于是"用户看到的位置"与"能点的位置"整体错开 16%：
//     点视觉上的「关闭X」   → hitTest 返回 null      → 关闭没反应
//     点视觉上的「开始对战」→ hitTest 返回 null      → 开始对战没反应
//     点视觉上的「上一页/下一页」→ 命中第 4 行陀螺  → 直接开战
//   （实测映射，2026-09-12 运行时取证；根因是"动画永远不收敛"，见下）
//   而所有其它 10 个面板都有 `this.game.xxxT = xxxOpen ? (... + dt) : 0` 的每帧递增，
//   唯独新加的 battleSelectT 漏写 → 动画永远停在 0 → 缩放永远 0.84、永远半透明。
//
// 教训 / 本套件新增的验证维度：**"矩形算得对"不等于"点得中"**。
// 用户点的是"看到的位置"，所以必须验证「视觉坐标 == 命中坐标」（即入场动画必须收敛到 scale=1）。
// 本套件据此锁死：
//   ⓿ 面板入场动画必须收敛（scale=1）；T=0 的三条错位现象可复现；每个面板计时器都必须在 update() 里递增
//   ① 开面板时互斥关闭其它模态（防回归礼包面板叠加导致命中错位）
//   ② render 后面板按钮全部注册进 modalRects；hitTest 逐个命中；面板外不穿透
//   ③ 点行 = **仅选中**（有可见反馈）；开战统一走「开始对战」
//   ④ 关闭X / 翻页 真实生效；单页时翻页有明确提示而非静默无效
//   ⑤ 源码级防回退标记

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// ── 最小 wx / canvas 桩（足够 Main 构造 + 渲染面板）──
const store = {};
const gradStub = () => ({ addColorStop: () => {} });
const canvas = { dpr: 1, width: 375, height: 812 };
const ctx = new Proxy({ canvas }, {
  get(t, p) {
    if (p === 'canvas') return canvas;
    if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return gradStub;
    if (p === 'measureText') return () => ({ width: 10 });
    return () => {};
  },
  set() { return true; },
});
global.wx = {
  setStorageSync: (k, v) => { store[k] = v; },
  getStorageSync: (k) => (k in store ? store[k] : ''),
  getSystemInfoSync: () => ({ model: 'iPhone', system: 'iOS 16', benchmarkLevel: 60, screenWidth: 375, screenHeight: 812, windowHeight: 778, statusBarHeight: 44, pixelRatio: 1 }),
  getMenuButtonBoundingClientRect: () => ({ top: 24, height: 32, left: 300, width: 60 }),
  onTouchStart: () => {}, onTouchMove: () => {}, onTouchEnd: () => {}, onTouchCancel: () => {},
  createImage: () => ({ set src(v) {}, onload: null, onerror: null }),
  createCanvas: () => ({ width: 0, height: 0, getContext: () => ctx }),
  onMemoryWarning: () => {}, requestAnimationFrame: () => 0, vibrateShort: () => {}, showToast: () => {},
};
global.requestAnimationFrame = () => 0;

const { Beyblade } = require('../src/beyblade');
const Main = require('../src/main');
const flush = () => new Promise(r => setTimeout(r, 0));

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const mainSrc = src('main.js');
const renderSrc = src('render.js');

// 复刻 beginPanelAnim 的缓动：t → scale（必须与 render.js 实现一致）
const DUR = 0.26, S_FROM = 0.84;
function scaleAt(t) {
  const k = Math.min(1, (t || 0) / DUR);
  const c1 = 1.03, c3 = c1 + 1;
  const ease = 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
  return S_FROM + (1 - S_FROM) * ease;
}

function newMain(nInv) {
  const m = new Main(canvas, ctx, global.wx.getSystemInfoSync());
  const g = m.game;
  g.homeV2 = true; g.mode = 'main'; g.tutorialDone = true; g.drawCard = null;
  g.energy = 100; g.coins = 500; g.save = () => {};
  const all = [new Beyblade(4, 5), new Beyblade(3, 4), new Beyblade(2, 3), new Beyblade(0, 1),
               new Beyblade(1, 2), new Beyblade(2, 1), new Beyblade(3, 2), new Beyblade(0, 3), new Beyblade(1, 1)];
  g.inventory = all.slice(0, nInv || 4);
  return m;
}
const renderN = (m, n) => { for (let i = 0; i < n; i++) m.renderer.render(0.016); };
// 渲染到面板按钮注册为止。⚠️ render() 前 2 帧是 splash 早退（_frameCount <= 2），不画任何面板，
// 所以"只渲染 1~2 帧"会得到空的 modalRects —— 这是本测试台踩过的坑。
function renderUntilPanel(m) {
  for (let i = 0; i < 8; i++) { m.renderer.render(0.016); if (m.renderer.modalRects.length) return; }
}
// 打开面板并把入场动画推进到收敛（模拟真机：每帧 update 后再 render）
function openSettled(m, ticks) {
  m._openBattleSelect();
  for (let i = 0; i < (ticks || 30); i++) m.update(0.02);
  renderUntilPanel(m);
}
// 用户视角点击：点在「看到的位置」＝把布局矩形中心经当前 scale 映射到屏幕坐标
function tapVisual(m, act) {
  const r = m.renderer.modalRects.find(x => x.action === act);
  if (!r) return false;
  const s = scaleAt(m.game.battleSelectT);
  const cx = m.renderer.width / 2, cy = m.renderer.height / 2;
  m.input.onTap({ x: cx + s * (r.x + r.w / 2 - cx), y: cy + s * (r.y + r.h / 2 - cy) });
  return true;
}
const firstPickAction = (m) => {
  const r = m.renderer.modalRects.find(x => x.action.indexOf('battle_select_pick_') === 0);
  return r ? r.action : null;
};

(async () => {
  // 【0】入场动画必须收敛：视觉坐标 == 命中坐标（本次事故的根因维度）
  console.log('\n【0】面板入场动画必须收敛（视觉位置 == 可点位置）');
  {
    const m0 = newMain(4);
    const CX = () => m0.renderer.width / 2, CY = () => m0.renderer.height / 2;
    // 把"布局矩形中心"换算成"用户看到的位置"：视觉 = 中心 + scale × (布局 - 中心)
    const seenAt = (r, s) => ({ x: CX() + s * (r.x + r.w / 2 - CX()), y: CY() + s * (r.y + r.h / 2 - CY()) });
    const hitSeen = (r) => { const p = seenAt(r, scaleAt(m0.game.battleSelectT)); return m0.renderer.hitTest(p.x, p.y); };

    m0._openBattleSelect();
    renderUntilPanel(m0);
    const s0 = scaleAt(m0.game.battleSelectT);
    ok('未推进动画时 scale = 0.84（sFrom）、alpha 0.4（面板被画成 84% 尺寸，命中仍按 1.0 布局 → 错位）', Math.abs(s0 - S_FROM) < 1e-6);

    const rClose = m0.renderer.modalRects.find(r => r.action === 'battle_select_close');
    const rConf = m0.renderer.modalRects.find(r => r.action === 'battle_select_confirm');
    const rNext = m0.renderer.modalRects.find(r => r.action === 'battle_select_next');
    const hitC0 = hitSeen(rClose), hitF0 = hitSeen(rConf), hitN0 = hitSeen(rNext);
    ok('复现①：T=0 时点"看到的关闭X" → 命中 null（= 关闭没反应，用户投诉之一）', hitC0 === null);
    ok('复现②：T=0 时点"看到的开始对战" → 命中 null（= 开始对战没反应，用户投诉之二）', hitF0 === null);
    // P1-6 压缩行距后落点变化（可能落入行间空隙）：断言放宽为「视觉点不命中 next 自身」——
    // 锁定本意（T=0 视觉位置与命中错位 = BSEL·3 事故维度：轻则无响应、重则误触他行），
    // 不再耦合旧行距的具体落点；T=1 收敛正确性由下方 scale==1 断言守卫。
    const misalignedN = (hitN0 === null) || (hitN0.action !== 'battle_select_next');
    ok('复现③：T=0 时点"看到的下一页" → 不命中自身（错位：无响应或误触他行）', misalignedN);
    if (!misalignedN) console.log('    [diag] hitN0.action =', hitN0 && hitN0.action);

    // 推进动画 → 必须收敛到 scale=1
    for (let i = 0; i < 30; i++) m0.update(0.02);
    ok('update 推进后 battleSelectT ≥ 0.26（入场动画走完）', (m0.game.battleSelectT || 0) >= 0.26);
    ok('收敛后 scale == 1（视觉坐标与命中坐标完全重合）', Math.abs(scaleAt(m0.game.battleSelectT) - 1) < 1e-9);

    renderUntilPanel(m0);
    const hitC1 = hitSeen(rClose), hitF1 = hitSeen(rConf);
    ok('收敛后点"看到的关闭X" → 命中 battle_select_close', !!hitC1 && hitC1.action === 'battle_select_close');
    ok('收敛后点"看到的开始对战" → 命中 battle_select_confirm', !!hitF1 && hitF1.action === 'battle_select_confirm');

    // 关闭后计时器归零（下次打开重新播放入场）
    m0.game.battleSelectOpen = false;
    m0.update(0.016);
    ok('面板关闭后 battleSelectT 归零', (m0.game.battleSelectT | 0) === 0);
  }

  // 【0b】类级不变量：每个面板的入场动画计时器都必须在 update() 里递增
  console.log('\n【0b】类级不变量：所有面板动画计时器都必须在 update() 中递增');
  {
    const names = [];
    const re = /beginPanelAnim\(\s*[A-Za-z_$][\w$.]*\.([A-Za-z0-9_]+)T\b/g;
    let mm;
    while ((mm = re.exec(renderSrc))) names.push(mm[1]);
    const uniq = names.filter((n, i) => names.indexOf(n) === i);
    ok('render.js 中识别到 ≥10 个面板入场动画计时器', uniq.length >= 10);
    const missing = uniq.filter(n => !(new RegExp('this\\.game\\.' + n + 'T\\s*=[^;]*\\+\\s*dt').test(mainSrc)));
    if (missing.length) console.log('     ⚠ 未递增: ' + missing.join(', '));
    ok('所有面板计时器在 main.js update() 中都有 +dt 递增（battleSelectT 漏写即此类 bug）', missing.length === 0);
  }

  // 【1】开面板：互斥 + 按钮注册
  console.log('\n【1】开面板：面板互斥 + 按钮注册进 modalRects');
  const m = newMain(4);
  const g = m.game;
  g.offlineOpen = true; g.dailyOpen = true; g.signOpen = true;
  openSettled(m);
  ok('battleSelectOpen = true', g.battleSelectOpen === true);
  ok('互斥关闭回归礼包面板 offlineOpen', g.offlineOpen === false);
  ok('互斥关闭每日任务面板 dailyOpen', g.dailyOpen === false);
  ok('互斥关闭签到面板 signOpen', g.signOpen === false);

  const acts = m.renderer.modalRects.map(r => r.action);
  ok('渲染后面板按钮已注册（>=7 个）', m.renderer.modalRects.length >= 7);
  ok('含关闭X battle_select_close', acts.indexOf('battle_select_close') >= 0);
  ok('含开始对战 battle_select_confirm', acts.indexOf('battle_select_confirm') >= 0);
  ok('含上一页 battle_select_prev', acts.indexOf('battle_select_prev') >= 0);
  ok('含下一页 battle_select_next', acts.indexOf('battle_select_next') >= 0);
  ok('含整行可点选 battle_select_pick_*', acts.filter(a => a.indexOf('battle_select_pick_') === 0).length >= 1);

  // 【2】hitTest 逐个命中 + 面板外不穿透
  console.log('\n【2】hitTest 命中校验（布局坐标）');
  {
    let allHit = true;
    for (const r of m.renderer.modalRects) {
      const hit = m.renderer.hitTest(r.x + r.w / 2, r.y + r.h / 2);
      if (!hit || hit.action !== r.action) { allHit = false; console.log('     未命中: ' + r.action + ' → ' + JSON.stringify(hit)); }
    }
    ok('每个面板按钮中心 hitTest 都返回自身 action', allHit);
    ok('面板外(10,10) 返回 null（不穿透主菜单）', m.renderer.hitTest(10, 10) === null);
  }

  // 【3】用户视角点击：点行=仅选中；开始对战=开战
  console.log('\n【3】点行 = 仅选中（不直接开战）；「开始对战」才开战');
  {
    const picks = m.renderer.modalRects.filter(r => r.action.indexOf('battle_select_pick_') === 0);
    const targetAct = picks[picks.length - 1].action;
    const chosen = targetAct.replace('battle_select_pick_', '');
    ok('用户点"看到的那一行"命中该行', tapVisual(m, targetAct));
    ok('点行后 battleSelectId = 被点那只', g.battleSelectId === chosen);
    ok('点行不再直接开战（mode 仍为 main）', g.mode === 'main');
    ok('点行后面板保持打开（可继续翻页/换选）', g.battleSelectOpen === true);

    renderN(m, 1);
    ok('用户点"看到的开始对战"', tapVisual(m, 'battle_select_confirm'));
    ok('开始对战后面板关闭', g.battleSelectOpen === false);
    ok('battleBbId 已持久化 = 选中那只', g.battleBbId === chosen);
    ok('mode 进入 battle', g.mode === 'battle');
    await flush(); await flush();  // battle.start() 异步就绪
    ok('战斗已初始化（battle.top 就绪）', !!(g.battle && g.battle.top));
    let drawn = true;
    try { m.update(0.016); m.renderer.render(0.016); } catch (e) { drawn = false; console.log('     ' + (e && e.message)); }
    ok('开战后战斗绘制无异常', drawn);
  }

  // 【4】关闭X / 翻页（用户视角点击）
  console.log('\n【4】关闭X 与翻页真实生效（用户视角点击）');
  {
    const m2 = newMain(4);      // 4 只 → 单页
    const g2 = m2.game;
    openSettled(m2);
    ok('用户点"看到的关闭X"→ 面板关闭', (tapVisual(m2, 'battle_select_close'), g2.battleSelectOpen === false));
    ok('render 回写总页数 battleSelectPages = 1', g2.battleSelectPages === 1);

    openSettled(m2);
    tapVisual(m2, 'battle_select_next');
    ok('单页时点下一页 → 页码不越界（仍为 0，且有「已是最后一页」提示）', (g2.battleSelectPage | 0) === 0);
    tapVisual(m2, 'battle_select_prev');
    ok('首页时点上一页 → 页码不变（有「已是第一页」提示）', (g2.battleSelectPage | 0) === 0);

    const m3 = newMain(9);      // 9 只 → 3 页
    const g3 = m3.game;
    openSettled(m3);
    const before = g3.battleSelectPage | 0;
    tapVisual(m3, 'battle_select_next');
    ok('多页时点下一页 → battleSelectPage 递增', (g3.battleSelectPage | 0) === before + 1);
    renderN(m3, 1);
    tapVisual(m3, 'battle_select_prev');
    ok('多页时点上一页 → 回到起始页', (g3.battleSelectPage | 0) === before);

    // 第二页的行也要能选中
    openSettled(m3);
    tapVisual(m3, 'battle_select_next');
    renderN(m3, 1);
    const pAct = firstPickAction(m3);
    const pId = pAct.replace('battle_select_pick_', '');
    tapVisual(m3, pAct);
    ok('翻页后第 2 页的行同样可选中', g3.battleSelectId === pId);
  }

  // 【5】源码级防回退
  console.log('\n【5】源码级防回退标记');
  ok('main.js 定义 _beginBattleWithSelected', mainSrc.indexOf('_beginBattleWithSelected()') >= 0);
  ok('开始对战分支调用 _beginBattleWithSelected',
    /a === 'battle_select_confirm'\)\s*\{\s*this\._beginBattleWithSelected\(\)/.test(mainSrc));
  ok('点行分支只设 battleSelectId（不直接调用开战）',
    /a\.indexOf\('battle_select_pick_'\) === 0\)[\s\S]{0,300}?gsel\.battleSelectId = a\.slice/.test(mainSrc) &&
    !/a\.indexOf\('battle_select_pick_'\) === 0\)[\s\S]{0,300}?this\._beginBattleWithSelected\(\)/.test(mainSrc));
  ok('battleSelectT 在 update() 中递增（本轮事故的根因修复）',
    /this\.game\.battleSelectT = this\.game\.battleSelectOpen \? \(\(this\.game\.battleSelectT \|\| 0\) \+ dt\) : 0;/.test(mainSrc));
  ok('翻页有边界提示（防"点了没反应"）', mainSrc.indexOf('已是最后一页') >= 0 && mainSrc.indexOf('已是第一页') >= 0);
  ok('开面板时做面板互斥（关闭 offlineOpen）', /_openBattleSelect\(\)[\s\S]{0,400}?g\.offlineOpen = false/.test(mainSrc));
  ok('开面板即预热 battle 子包（消除首次进战首页瞬态）', /_openBattleSelect\(\)[\s\S]{0,1200}?_ensureBattle\(\)\.catch/.test(mainSrc));
  ok('首屏 onShow 即预热 battle 子包（比开面板更早，逛首页时分包已就绪）', /wx\.onShow[\s\S]{0,500}?_ensureBattle\(\)\.catch/.test(mainSrc));
  ok('增益按钮 buff 独立开增益面板（未被选陀螺面板取代）', /a === 'buff'\)\s*\{[\s\S]{0,240}?buffOpen = true/.test(mainSrc));
  ok('面板带可见构建标记 BSEL', renderSrc.indexOf('BSEL') >= 0);
  ok('drawBattleSelectPanel 有 try/catch 兜底（防单面板异常拖垮整帧）',
    /drawBattleSelectPanel\(\)\s*\{[\s\S]*?try \{[\s\S]*?catch \(e\)/.test(renderSrc));
  ok('元素角标取值有兜底（elementInfo 缺失不抛错）', renderSrc.indexOf('bb.elementInfo || {') >= 0);
  ok('面板高度容得下 4 行 + 翻页 + 底部按钮（bh ≥ 570）', /const bw = Math\.min\(360, w - 40\), bh = (\d+);/.test(renderSrc) &&
    parseInt(/const bw = Math\.min\(360, w - 40\), bh = (\d+);/.exec(renderSrc)[1], 10) >= 570);

  // 【6】端到端：从主界面「对战」按钮进入 → 选 → 开战（用户真实路径）
  console.log('\n【6】端到端：点主界面「对战」→ 面板 → 选行 → 开始对战');
  {
    const m4 = newMain(4);
    const g4 = m4.game;
    renderUntilPanel(m4);   // 主场景渲染（会注册主界面 buttons）
    const btn = m4.renderer.buttons.find(b => b.action === 'battle_quick');
    ok('主界面「对战」按钮已注册（action = battle_quick）', !!btn);
    if (!btn) {
      ok('点「对战」→ battleSelectOpen = true', false);
      ok('点「对战」不会直接开战（mode 仍为 main）', false);
    } else {
      m4.input.onTap({ x: btn.x + btn.w / 2, y: btn.y + btn.h / 2 });
      ok('点「对战」→ battleSelectOpen = true', g4.battleSelectOpen === true);
      ok('点「对战」不会直接开战（mode 仍为 main）', g4.mode === 'main');
      for (let i = 0; i < 30; i++) m4.update(0.02);
      renderUntilPanel(m4);
      const p = firstPickAction(m4);
      tapVisual(m4, p);
      renderUntilPanel(m4);
      ok('面板内点行 → 选中该行', g4.battleSelectId === p.replace('battle_select_pick_', ''));
      tapVisual(m4, 'battle_select_confirm');
      await flush(); await flush();
      ok('点「开始对战」→ 进入战斗且战斗就绪', g4.mode === 'battle' && !!(g4.battle && g4.battle.top));
      let d2 = true;
      try { m4.update(0.016); m4.renderer.render(0.016); } catch (e) { d2 = false; console.log('     ' + (e && e.message)); }
      ok('战斗绘制无异常', d2);
    }
  }

  console.log('\n══════════════════════');
  console.log((fail === 0 ? '✅' : '❌') + ' smoke_battle_select_interact：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();
