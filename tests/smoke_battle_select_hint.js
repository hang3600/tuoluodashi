// 批次F·选陀螺面板「点选文字提示只弹一次 + 点选脉冲反馈」门禁（2026-09-12）
//
// 背景（用户反馈原话大意）：面板上本来就已经写清「已选：XX Lv5 · 点下方『开始对战』开战」，
//   行上还有高亮 + ✓ 出战；可每点一只陀螺仍弹一条「已选择 XX Lv5 · 点『开始对战』开战」的 toast，
//   每选一只弹一次 = 纯噪音。要求：**只弹一次（新用户首次），往后不再弹。**
// 落地方案：
//   ① `game.battleSelectHinted` 入存档：首次点选时弹一次 → 置 true + save() → 之后永久静默（跨会话也不弹）。
//   ② 去掉逐次文字提示后仍要保证"点了有反应"：点选瞬间给 0.3s 描边脉冲
//      （`battleSelectFlashId` / `battleSelectFlashT`），连点同一行也能看到反馈；
//      脉冲每帧递减（**不依赖面板开关**，关掉面板也必须收敛到 0，避免描边常亮残留）。
//
// 本套件锁死：
//   ⓿ 构造器默认（hinted=false / flash 复位）、脉冲每次点选都重新计时且能收敛
//   ① 真实 Main：首次点选弹 1 条、第二次起不弹、关面板重开再点仍不弹
//   ② 跨会话：save → load 后 hinted=true，新会话也不会再弹
//   ③ 源码级防回退：toast 必须被 `if (!gsel.battleSelectHinted)` 包住；update 必须有递减行

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// ── 最小 wx / canvas 桩（与 smoke_battle_select_interact.js 同构）──
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
const { GameState } = require('../src/game');
const Main = require('../src/main');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const mainSrc = src('main.js');
const renderSrc = src('render.js');
const gameSrc = src('game.js');

// 复刻 beginPanelAnim 的缓动（与 render.js 一致）：用于把"布局矩形"换算成"用户看到的位置"
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
// ⚠️ render() 前 2 帧是 splash 早退（_frameCount <= 2），只渲染 1~2 帧会拿到空 modalRects
function renderUntilPanel(m) {
  for (let i = 0; i < 8; i++) { m.renderer.render(0.016); if (m.renderer.modalRects.length) return; }
}
// 打开面板并把入场动画推进到收敛（scale=1，视觉位置 == 命中位置）
function openSettled(m, ticks) {
  m._openBattleSelect();
  for (let i = 0; i < (ticks || 30); i++) m.update(0.02);
  renderUntilPanel(m);
}
function tapVisual(m, act) {
  const r = m.renderer.modalRects.find(x => x.action === act);
  if (!r) return false;
  const s = scaleAt(m.game.battleSelectT);
  const cx = m.renderer.width / 2, cy = m.renderer.height / 2;
  m.input.onTap({ x: cx + s * (r.x + r.w / 2 - cx), y: cy + s * (r.y + r.h / 2 - cy) });
  return true;
}
const pickActs = (m) => m.renderer.modalRects.filter(r => r.action.indexOf('battle_select_pick_') === 0);
const firstPickAction = (m) => { const a = pickActs(m); return a.length ? a[0].action : null; };
const idOf = (act) => act.replace('battle_select_pick_', '');
// 包装 _toast（仍走原逻辑，只是记录）：只统计"点选"导致的增量
function spyToast(m) {
  const list = [];
  const orig = m._toast.bind(m);
  m._toast = (msg, ...rest) => { list.push(String(msg)); return orig(msg, ...rest); };
  return list;
}

(async () => {
  // 【0】构造器默认
  console.log('\n【0】构造器默认状态');
  {
    const g = new GameState();
    ok('battleSelectHinted 默认 false（新用户）', g.battleSelectHinted === false);
    ok('battleSelectFlashId 默认 null', g.battleSelectFlashId === null);
    ok('battleSelectFlashT 默认 0', g.battleSelectFlashT === 0);
  }

  // 【1】真实 Main：首次点选弹一次，之后不再弹
  console.log('\n【1】真实 Main：文字提示只弹一次');
  {
    const m = newMain(4);
    const g = m.game;
    let saveCalls = 0;
    g.save = () => { saveCalls++; };
    const t = spyToast(m);
    openSettled(m);

    const p1 = firstPickAction(m);
    const base = t.length;
    const sc0 = saveCalls;   // ⚠️ update() 自带自动存档，必须用「点选前后的增量」判定，不能用绝对次数
    tapVisual(m, p1);
    ok('首次点选 → 弹 1 条「已选择 XX」提示', t.length === base + 1 && /已选择/.test(t[base] || ''));
    ok('首次点选 → 选中生效', g.battleSelectId === idOf(p1));
    ok('首次点选 → battleSelectHinted 置 true', g.battleSelectHinted === true);
    ok('首次点选 → 触发落盘 save()（较点选前 +1）', saveCalls === sc0 + 1);

    // 第二次点另一行（翻页后点同一页的另一只）
    renderN(m, 1);
    const rows = pickActs(m);
    const p2 = rows.length > 1 ? rows[1].action : rows[0].action;
    const before2 = t.length;
    const sc1 = saveCalls;
    tapVisual(m, p2);
    ok('第二次点选 → **不再弹提示**', t.length === before2);
    ok('第二次点选 → 选中仍然生效（不是"点了没反应"）', g.battleSelectId === idOf(p2));
    ok('第二次点选 → 不再重复 save()（增量 0）', saveCalls === sc1);

    // 关面板 → 重开 → 再点，仍不弹
    renderN(m, 1);
    tapVisual(m, 'battle_select_close');
    ok('点关闭X → 面板关闭', g.battleSelectOpen === false);
    openSettled(m);
    renderN(m, 1);
    const rows3 = pickActs(m);
    const before3 = t.length;
    tapVisual(m, rows3[0].action);
    ok('关面板重开后再点 → 仍不弹提示（面板生命周期内也是一次性）', t.length === before3);
  }

  // 【2】跨会话：入存档后新会话不再弹
  console.log('\n【2】跨会话持久化（新用户只弹一次，重开游戏也不弹）');
  {
    const ga = new GameState();
    ok('新档（无字段）→ hinted=false → 仍会弹一次', ga.battleSelectHinted === false);
    ga.battleSelectHinted = true;
    ga.save(true);                 // 同步落盘到 wx 桩
    const gb = new GameState();
    gb.load();
    ok('save→load 后 hinted 仍为 true（跨会话不再弹）', gb.battleSelectHinted === true);

    // 老存档（完全没有该字段）→ 回落 false，仍给一次引导提示（向后兼容，不报错）
    // ⚠️ 存档在 storage 里是 JSON **字符串**（不是对象），必须 parse → 删字段 → stringify 写回
    for (const k of Object.keys(store)) {
      let raw = store[k];
      if (raw && typeof raw !== 'string') { try { raw = JSON.stringify(raw); } catch (e) { continue; } }
      if (typeof raw !== 'string' || raw.indexOf('battleSelectHinted') < 0) continue;
      try {
        const o = JSON.parse(raw);
        delete o.battleSelectHinted;
        store[k] = JSON.stringify(o);
      } catch (e) {}
    }
    const gc = new GameState();
    gc.load();
    ok('老存档缺字段 → 不抛错且 hinted 回落 false（首次仍给引导）', gc.battleSelectHinted === false);
  }

  // 【3】点选脉冲：即时反馈 + 每帧递减收敛
  console.log('\n【3】点选脉冲（替代逐次 toast 的即时反馈）');
  {
    const m = newMain(4);
    const g = m.game;
    spyToast(m);
    openSettled(m);
    const pA = firstPickAction(m);
    tapVisual(m, pA);
    ok('点选瞬间 → 脉冲计时置 0.3s', Math.abs((g.battleSelectFlashT || 0) - 0.3) < 1e-6);
    ok('脉冲绑定到被点的那一行', g.battleSelectFlashId === idOf(pA));
    let drew = true;
    try { renderN(m, 1); } catch (e) { drew = false; console.log('     ' + (e && e.message)); }
    ok('脉冲绘制路径渲染无异常', drew);

    for (let i = 0; i < 8; i++) m.update(0.05);   // 0.4s > 0.3s
    ok('0.4s 后脉冲收敛为 0（不会常亮残留）', g.battleSelectFlashT === 0);

    // 连点同一行：仍能看到反馈（脉冲重置）
    renderN(m, 1);
    tapVisual(m, pA);
    ok('再点同一行 → 脉冲重新计时（连点同一行也有反馈）', (g.battleSelectFlashT || 0) > 0);

    // 关面板后也必须收敛（递减不依赖面板开关）
    renderN(m, 1);
    tapVisual(m, 'battle_select_close');
    ok('关闭面板', g.battleSelectOpen === false);
    for (let i = 0; i < 8; i++) m.update(0.05);
    ok('关面板后脉冲仍收敛为 0（递减不依赖 battleSelectOpen）', g.battleSelectFlashT === 0);
  }

  // 【4】源码级防回退标记
  console.log('\n【4】源码级防回退标记');
  {
    ok('点选分支带首次守卫 if (!gsel.battleSelectHinted)', mainSrc.indexOf('if (!gsel.battleSelectHinted)') >= 0);
    ok('「已选择」toast 被首次守卫包住（不是无条件弹）',
      /if \(!gsel\.battleSelectHinted\)\s*\{[\s\S]{0,300}?_toast\('已选择 /.test(mainSrc));
    ok('「已选择」toast 全文件只出现 1 次', (mainSrc.split("_toast('已选择 ").length - 1) === 1);
    ok('首次弹完后置 hinted=true 并 save()',
      /gsel\.battleSelectHinted = true;[\s\S]{0,120}?gsel\.save\(\)/.test(mainSrc));
    ok('点选时重置脉冲（flashId + 0.3s）',
      /gsel\.battleSelectFlashId = gsel\.battleSelectId;[\s\S]{0,120}?gsel\.battleSelectFlashT = 0\.3;/.test(mainSrc));
    ok('update() 每帧递减脉冲（含 Math.max 收敛保护）',
      /if \(this\.game\.battleSelectFlashT > 0\) this\.game\.battleSelectFlashT = Math\.max\(0, this\.game\.battleSelectFlashT - dt\);/.test(mainSrc));
    ok('脉冲递减不在 battleSelectOpen 守卫内（关面板也收敛）',
      !/battleSelectOpen\s*\?[^\n]*battleSelectFlashT/.test(mainSrc));
    ok('render.js 绘制脉冲描边', renderSrc.indexOf('battleSelectFlashId === bb.id') >= 0 && /battleSelectFlashT \|\| 0\) \/ 0\.3/.test(renderSrc));
    ok('构建标记升级为 BSEL·5（真机可一眼确认跑的是新包；4=只弹一次/5=元素绑定品质）', renderSrc.indexOf('BSEL·5') >= 0);
    ok('存档写入 battleSelectHinted', gameSrc.indexOf('battleSelectHinted: this.battleSelectHinted ? 1 : 0') >= 0);
    ok('存档恢复 battleSelectHinted', gameSrc.indexOf('this.battleSelectHinted = !!data.battleSelectHinted;') >= 0);
    ok('面板顶部「已选」文案仍在（去掉 toast 后仍有状态显示）', renderSrc.indexOf("已选：") >= 0);
  }

  console.log('\n══════════════════════');
  console.log((fail === 0 ? '✅' : '❌') + ' smoke_battle_select_hint：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();
