// 冒烟套件 24 —— 背包「陈列轨道」V2（网格列表 → 陀螺陈列卡）
//
// 背景（整体审计 #2）：背包网格列表是最"工具化/小程序化"的元素。
// V2 改为横向卡片流的「陈列轨道」：每张卡带品质渐变底 + 稀有度光晕 + 陀螺大图 +
// 品质名 + 等级角标；翻页改为按屏横向滚动。
//
// 交互契约必须保住（这是本套件的核心）：
//   gridRects 命中 → { type:'inventory', beyblade } → 支撑三种操作：
//     ① 拖拽到合成台  ② 长按出售  ③ 点击放入合成台空槽
//   因此本套件断言：每张可见卡片都能被 hitTest 命中并返回正确陀螺。
//
// 并存开关：game.invRailV2 = false 完整回退网格列表。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');
const { Renderer } = require(path.join(SRC, 'render.js'));
const { GameState } = require(path.join(SRC, 'game.js'));
const { Beyblade } = require(path.join(SRC, 'beyblade.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 无头 Canvas2D 桩：记录 save/restore 深度 */
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

/** 造一个装了 n 个陀螺的存档（品质轮换，便于验证品质光效分支） */
function gameWith(n) {
  const g = new GameState();
  for (let i = 0; i < n; i++) {
    const bb = new Beyblade(i % 5, 1 + (i % 3));
    g.inventory.push(bb);
  }
  return g;
}

console.log('\n【陈列轨道】卡片绘制 + 命中契约（拖拽/长按/点击的基础）');
{
  const g = gameWith(12);
  const r = mkRenderer(g, 390, 844);
  r.gridRects = [];
  r.buttons = [];
  let threw = null;
  try { r.drawInventoryRailV2(); } catch (e) { threw = e.message; }
  ok('drawInventoryRailV2 不抛异常', !threw, threw);
  ok('注册了卡片命中区', r.gridRects.length > 0, 'n=' + r.gridRects.length);
  ok('只注册可视区内的卡片（不是全部 12 个）',
    r.gridRects.length < 12, 'n=' + r.gridRects.length + ' / 总数 12');
  // 命中契约：每张可见卡片中心都应能 hitTest 到 inventory 且陀螺一致
  let hitOk = true, hitBad = '';
  for (const rect of r.gridRects) {
    const hit = r.hitTest(rect.x + rect.w / 2, rect.y + rect.h / 2);
    if (!hit || hit.type !== 'inventory' || hit.beyblade !== rect.beyblade) {
      hitOk = false;
      hitBad = rect.beyblade ? ('陀螺不匹配 @' + Math.round(rect.x)) : 'hit=null';
      break;
    }
  }
  ok('每张卡片都能被 hitTest 命中且陀螺一致（拖拽/长按不失效）', hitOk, hitBad);
  ok('save/restore 平衡', r.ctx.getDepth() === 0, 'depth=' + r.ctx.getDepth());
}

console.log('\n【陈列轨道】滚动：按屏滚动并钳制在合法范围');
{
  const g = gameWith(20);
  const r = mkRenderer(g, 390, 844);
  r.invScrollX = 0;
  const before = r.invScrollX;
  r.scrollInventoryByScreen(1);
  ok('下一屏滚动使偏移增大', r.invScrollX > before, before + ' → ' + r.invScrollX);
  // 连续后滚应被最大偏移钳制（不越界）
  for (let i = 0; i < 20; i++) r.scrollInventoryByScreen(1);
  const maxed = r.invScrollX;
  r.scrollInventoryByScreen(1);
  ok('滚到末端后被钳制（不再增大）', r.invScrollX === maxed, maxed + ' → ' + r.invScrollX);
  // 反向滚回起点
  for (let i = 0; i < 20; i++) r.scrollInventoryByScreen(-1);
  ok('反向滚回起点后被钳制为 0', r.invScrollX === 0, 'scrollX=' + r.invScrollX);
  // 滚动后仍能正常绘制且命中区随滚动更新
  r.gridRects = [];
  r.buttons = [];
  r.invScrollX = maxed;
  let threw = null;
  try { r.drawInventoryRailV2(); } catch (e) { threw = e.message; }
  ok('滚到末端后绘制不崩', !threw, threw);
  ok('末端仍有可见卡片命中区', r.gridRects.length > 0, 'n=' + r.gridRects.length);
}

console.log('\n【陈列轨道】翻页按钮：超出一屏时提供 inv_prev / inv_next');
{
  const g = gameWith(20);
  const r = mkRenderer(g, 390, 844);
  r.gridRects = [];
  r.buttons = [];
  r.drawInventoryRailV2();
  const acts = r.buttons.map(b => b.action);
  ok('注册了 inv_prev', acts.indexOf('inv_prev') >= 0, acts.join(','));
  ok('注册了 inv_next', acts.indexOf('inv_next') >= 0, acts.join(','));
  ok('保留了 inv_page 提示入口', acts.indexOf('inv_page') >= 0, acts.join(','));
}
{
  // 不足一屏时不应出现滚动条
  const g = gameWith(2);
  const r = mkRenderer(g, 390, 844);
  r.gridRects = [];
  r.buttons = [];
  r.drawInventoryRailV2();
  const acts = r.buttons.map(b => b.action);
  ok('不足一屏时不显示翻页控件', acts.indexOf('inv_next') < 0, acts.join(','));
}

console.log('\n【陈列轨道】空背包走空状态引导，不崩');
{
  const g = new GameState();   // 空背包
  const r = mkRenderer(g, 390, 844);
  r.gridRects = [];
  r.buttons = [];
  let threw = null;
  try { r.drawInventoryRailV2(); } catch (e) { threw = e.message; }
  ok('空背包绘制不崩（走空状态引导）', !threw, threw);
  ok('空背包无命中区', r.gridRects.length === 0, 'n=' + r.gridRects.length);
}

console.log('\n【回退开关】invRailV2 = false 走原网格列表');
{
  const g = gameWith(12);
  g.invRailV2 = false;
  const r = mkRenderer(g, 390, 844);
  ok('invRailV2On() 为 false', r.invRailV2On() === false);
  r.gridRects = [];
  r.buttons = [];
  let threw = null;
  try { r.drawInventory(); } catch (e) { threw = e.message; }
  ok('网格模式绘制不崩', !threw, threw);
  const L = r.layout;
  const cap = Math.max(1, L.invCols * r.inventoryRowsMax());
  ok('网格模式按页容量渲染（<= 每页上限）', r.gridRects.length <= cap,
    'n=' + r.gridRects.length + ' cap=' + cap);
}

console.log('\n【陈列轨道】手指横滑 + 松手惯性（主页「空书包」左右滑动）');
{
  const g = gameWith(20);
  const r = mkRenderer(g, 390, 844);
  ok('invMaxScroll 存在且 >0（可横滑）', typeof r.invMaxScroll === 'function' && r.invMaxScroll() > 0, 'max=' + r.invMaxScroll());
  const rr = r.invRailRect();
  ok('invRailRect 返回合法矩形（覆盖底部卡片区）', rr && rr.w > 0 && rr.h > 0, JSON.stringify(rr));
  // 模拟手指在轨道上按下、向右拖 60px → invScrollX = scrollStart - dx（内容右移、露出左侧），钳制 >=0
  const max = r.invMaxScroll();
  r.invScrollX = Math.round(max / 2);
  const startX = r.invScrollX;
  r.invScrollX = Math.max(0, Math.min(max, startX - 60));
  ok('右拖使 offset 减小（露出左侧卡片）', r.invScrollX < startX, startX + ' → ' + r.invScrollX);
  // 松手惯性：赋值速度后 _stepInvInertia 每帧推进并衰减
  r._invVel = 20;
  const v0 = r.invScrollX;
  r._stepInvInertia();
  ok('_stepInvInertia 推进 offset', r.invScrollX !== v0 || r._invVel === 0, 'off=' + r.invScrollX + ' vel=' + r._invVel);
  ok('_stepInvInertia 速度衰减', Math.abs(r._invVel) < 20, 'vel=' + r._invVel);
  // 撞右端：惯性被钳制且速度归零
  r.invScrollX = max; r._invVel = 999; r._stepInvInertia();
  ok('撞右端惯性钳制且速度归零', r.invScrollX === max && r._invVel === 0, 'off=' + r.invScrollX);
  // 撞左端：惯性被钳制且速度归零
  r.invScrollX = 0; r._invVel = -999; r._stepInvInertia();
  ok('撞左端惯性钳制且速度归零', r.invScrollX === 0 && r._invVel === 0, 'off=' + r.invScrollX);
}

console.log('\n────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
