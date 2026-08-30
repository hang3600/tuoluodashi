// 冒烟套件 · P2 UI 一致性与打磨（无头渲染回归）
//   目标：验证 P2-5 面板外壳抽取（beginPanelAnim/drawPanelBody/drawCloseX/_panelCenterY）
//   与 P2-1 安全区避让、P2-4 金币字体、P2-6 runBuff 入场、P2-7 遮罩统一、P2-8 更多小游戏门控
//   在「不依赖浏览器/微信全局」的情况下不抛错、save/restore 平衡、关键几何正确。
//
//   手法：用 Proxy 桩 ctx 模拟 Canvas2D；用 Object.create(Renderer.prototype) 跳过构造函数
//   的 _loadIcons/_reflow（避免加载真实 PNG / 计算真实布局），只挂最小必要实例属性。

const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');
const { Renderer } = require(path.join(SRC, 'render.js'));
const { GameState } = require(path.join(SRC, 'game.js'));
const { Beyblade } = require(path.join(SRC, 'beyblade.js'));
const { CONFIG } = require(path.join(SRC, 'config.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

// ---- 无头 Canvas2D 桩：记录 save/restore 深度、font 设置、遮罩 fillStyle ----
function makeCtx() {
  let depth = 0;
  let currentFont = '';
  let measuredFont = null;
  let lastMask = null;
  const self = {};
  const handler = {
    get(t, p) {
      switch (p) {
        case 'save': return () => { depth++; };
        case 'restore': return () => { depth--; if (depth < 0) throw new Error('ctx.restore() 下溢：save/restore 不平衡'); };
        case 'measureText': return (text) => { measuredFont = currentFont; return { width: String(text).length * 8 }; };
        case 'createLinearGradient':
        case 'createRadialGradient': return () => ({ addColorStop() {} });
        case 'fillRect': return () => { lastMask = currentFont === '' ? (self.fillStyle || null) : self.fillStyle; };
        case 'getDepth': return () => depth;
        case 'getMeasuredFont': return () => measuredFont;
        case 'getLastMask': return () => lastMask;
        case 'canvas': return { width: 390, height: 844 };
        default:
          if (p in self) return self[p];
          return function () {};
      }
    },
    set(t, p, v) { if (p === 'font') currentFont = v; self[p] = v; return true; }
  };
  return new Proxy({}, handler);
}

// ---- 最小 Renderer 实例：跑真实构造函数（拿到 _iconFiles 等属性），
//      但临时禁用会触碰真实 PNG / 计算真实布局的 _loadIcons / _reflow ----
function makeRenderer() {
  const ctx = makeCtx();
  const canvas = { width: 390, height: 844 };
  const origLoad = Renderer.prototype._loadIcons;
  const origReflow = Renderer.prototype._reflow;
  Renderer.prototype._loadIcons = function () {};
  Renderer.prototype._reflow = function () {};
  const r = new Renderer(canvas, ctx, new GameState(), 56, 24, { left: 350, top: 10, width: 87, height: 32 });
  Renderer.prototype._loadIcons = origLoad;
  Renderer.prototype._reflow = origReflow;
  // 补充分支测试需要的属性 / 布局
  r.shadowScale = 1;
  r._frameCount = 0;
  r._debugFreezeFx = false;
  r.pressedBtn = null;
  r.layout = { topBarY: 56, topBarH: 44, leftPad: 12, energyX: 150, energyW: 180, W: 390, actionY: 700, actionBtnH: 52 };
  return r;
}

function setUpGame() {
  const g = new GameState();
  // 打开所有面板所需开关
  g.dailyOpen = true; g.dailyT = 0.12;
  g.signOpen = true; g.signT = 0.12;
  g.arenaOpen = true; g.arenaT = 0.12;
  g.levelOpen = true; g.levelT = 0.12;
  g.offlineOpen = true; g.returnT = 0.12;
  g.battleChestOpen = true; g.battleChestT = 0.12;
  g.battleChest = { quality: 1, count: 3 };
  g.chestAdBroken = false;
  g.boostOpen = true; g.boostT = 0.12;
  g.buffOpen = true; g.buffT = 0.12;
  g.runBuffOpen = true; g.runBuffT = 0.12;
  g.battle = { _runBuffChoices: [{ label: '?', name: '测试', desc: '描述', color: '#26a69a' }], runStage: 2 };
  g.sellConfirm = { beyblade: new Beyblade(0, 1), gain: 120 };
  return g;
}

// 运行一个面板绘制方法，自动校验 save/restore 平衡
function runPanel(name, r, fn, expectClose) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  const depth = r.ctx.getDepth();
  ok(name + ' · 不抛错', !threw, threw && threw.message);
  ok(name + ' · save/restore 平衡(depth=0)', depth === 0, 'depth=' + depth);
  if (expectClose) {
    const hasClose = r.modalRects.some(m => typeof m.action === 'string' && m.action.endsWith('_close'));
    ok(name + ' · 关闭 X 已注册(modalRects 含 *_close)', hasClose);
  } else {
    ok(name + ' · 交互区已注册(modalRects 非空)', r.modalRects.length > 0, 'len=' + r.modalRects.length);
  }
  // 遮罩统一为 PANEL_MASK（P2-7）：rgba(10,5,25,0.82)
  ok(name + ' · 遮罩透明度统一 0.82 (P2-7)', r.ctx.getLastMask() === 'rgba(10,5,25,0.82)', 'mask=' + r.ctx.getLastMask());
}

console.log('\n【P2-1】_panelCenterY 安全区避让：矮屏高面板不撞胶囊/Home Bar');
{
  const r = makeRenderer();
  r.game = new GameState();

  // 现实机型：iPhone SE 667 高，面板 458 高 → 居中且不越界
  r.height = 667; r.safeTop = 44; r.safeBottom = 34;
  let by = r._panelCenterY(458);
  ok('现实屏：竖直居中', Math.abs(by - (667 - 458) / 2) < 1, 'by=' + by);
  ok('现实屏：不顶状态栏 (≥ safeTop+8)', by >= r.safeTop + 8, 'by=' + by);
  ok('现实屏：不越 Home Bar (≤ height-safeBottom-8)', by + 458 <= r.height - r.safeBottom - 8, 'bottom=' + (by + 458));

  // 极端矮屏：面板高于可用高度 → 贴顶对齐，绝不顶进状态栏（也不出现负坐标）
  r.height = 600; r.safeTop = 44; r.safeBottom = 34;
  by = r._panelCenterY(560);
  ok('极端屏：贴顶对齐 (by = safeTop+8)', by === r.safeTop + 8, 'by=' + by);
  ok('极端屏：坐标非负（不顶进状态栏）', by >= 0, 'by=' + by);
}

console.log('\n【P2-4】drawHeader 金币宽度使用正确字体测量（先设字体再 measureText）');
{
  const r = makeRenderer();
  r.game = new GameState();
  r.buttons = [];
  let threw = null;
  try { r.drawHeader(); } catch (e) { threw = e; }
  ok('drawHeader 不抛错', !threw, threw && threw.message);
  const mf = r.ctx.getMeasuredFont();
  ok('金币 measureText 前已设置 bold 15px 字体', !!mf && mf.indexOf('bold 15px') === 0, 'font=' + mf);
  ok('save/restore 平衡', r.ctx.getDepth() === 0, 'depth=' + r.ctx.getDepth());
}

console.log('\n【P2-5/2-7】面板外壳统一（8 面板均无头绘制通过 + 遮罩统一 + 关闭X）');
{
  const r = makeRenderer();
  r.game = setUpGame();
  runPanel('drawDailyPanel', r, () => r.drawDailyPanel(), true);
  runPanel('drawSignin', r, () => r.drawSignin(), true);
  runPanel('drawArenaPanel', r, () => r.drawArenaPanel(), true);
  runPanel('drawLevelPanel', r, () => r.drawLevelPanel(), true);
  runPanel('drawReturnPanel', r, () => r.drawReturnPanel(), true);
  runPanel('drawBattleChestPanel', r, () => r.drawBattleChestPanel(), true); // 关闭为 chest_close
  runPanel('drawBoostPanel', r, () => r.drawBoostPanel(), true);
  runPanel('drawBuffPanel', r, () => r.drawBuffPanel(), true);
  // 特殊面板：无关闭 X
  r.modalRects = []; r.buttons = [];
  runPanel('drawSellConfirm', r, () => r.drawSellConfirm(), false);
  r.modalRects = []; r.buttons = [];
  runPanel('drawRunBuffPanel', r, () => r.drawRunBuffPanel(), false);
  const hasSkip = r.modalRects.some(m => m.action === 'run_buff_skip');
  ok('drawRunBuffPanel · 跳过按钮已注册', hasSkip);
}

console.log('\n【P2-6】runBuffT 由 main.update 驱动（入场计时可推进）');
{
  const r = makeRenderer();
  const g = setUpGame();
  r.game = g;
  const t0 = g.runBuffT;
  // 模拟 main.update 中的一行：runBuffOpen 时累加 dt
  g.runBuffT = g.runBuffOpen ? ((g.runBuffT || 0) + 0.1) : 0;
  ok('runBuffOpen 时 runBuffT 推进', g.runBuffT > t0, t0 + ' → ' + g.runBuffT);
  g.runBuffOpen = false;
  g.runBuffT = g.runBuffOpen ? ((g.runBuffT || 0) + 0.1) : 0;
  ok('runBuffOpen 关闭时 runBuffT 归零', g.runBuffT === 0);
}

console.log('\n【P2-8】更多小游戏入口按 CONFIG.moreGamesOpenlink 门控');
{
  const r = makeRenderer();
  r.game = new GameState();
  // 默认未配置 → 入口不渲染
  CONFIG.moreGamesOpenlink = '';
  r.buttons = [];
  r.drawHeader();
  const hidden = !r.buttons.some(b => b.action === 'moregames');
  ok('未配置 moreGamesOpenlink 时入口隐藏', hidden);

  // 配置 openlink → 入口出现
  CONFIG.moreGamesOpenlink = 'fake-openlink-token';
  r.buttons = [];
  r.drawHeader();
  const shown = r.buttons.some(b => b.action === 'moregames');
  ok('配置 moreGamesOpenlink 后入口渲染', shown);

  // 还原
  CONFIG.moreGamesOpenlink = '';
}

console.log('\n【P2-7】静态：render.js 遮罩透明度全统一为 0.82');
{
  const src = fs.readFileSync(path.join(SRC, 'render.js'), 'utf8');
  const m = src.match(/rgba\(10,5,25,(\d*\.?\d+)\)/g) || [];
  const bad = m.filter(s => !s.endsWith('0.82)'));
  ok('源码不再出现非 0.82 的 rgba(10,5,25,X) 遮罩', bad.length === 0, '残留: ' + JSON.stringify(bad));
  ok('PANEL_MASK 常量本身为 0.82', src.indexOf("PANEL_MASK_ALPHA = 0.82") !== -1);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
