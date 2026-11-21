// 批次F·出战陀螺选择面板（选项B）门禁
//   运行时：selectBattleBeyblade 优先读 battleBbId → 合成台中央格 → 战力最高兜底；
//            setBattleBeyblade 持久化；存档 round-trip 恢复 id + battleBbId。
//   源码级：main.js 对战/buff 入口改开选陀螺面板、动作分发齐全；render.js 面板绘制 + 命中守卫。

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// ── 运行时：用最小 wx 桩驱动存档读写 ──
const store = {};
global.wx = {
  setStorageSync: (k, v) => { store[k] = v; },
  getStorageSync: (k) => (k in store ? store[k] : ''),
  getSystemInfoSync: () => ({}),
  createImage: undefined,
};

const { GameState } = require('../src/game');
const { Beyblade } = require('../src/beyblade');

console.log('\n【1】构造器默认状态');
{
  const g = new GameState();
  ok('battleBbId 默认 null', g.battleBbId === null);
  ok('battleSelectId 默认 null（纯 UI）', g.battleSelectId === null);
  ok('battleSelectOpen 默认 false（纯 UI）', g.battleSelectOpen === false);
}

console.log('\n【2】selectBattleBeyblade 选择优先级');
{
  const g = new GameState();
  const strong = new Beyblade(4, 5); // 金·传说 Lv5，战力最高
  const weak = new Beyblade(0, 1);   // 土·普通 Lv1
  g.inventory.push(weak, strong);
  ok('未指定 → 选战力最高', g.selectBattleBeyblade() === strong);

  // 指定 weak 出战
  g.setBattleBeyblade(weak);
  ok('setBattleBeyblade 写入 battleBbId', g.battleBbId === weak.id);
  ok('指定后 → 选 weak（不再按战力最高）', g.selectBattleBeyblade() === weak);

  // 选中的被出售/合并 → 清除过期选择并回落战力最高
  g.inventory = [strong];
  const r = g.selectBattleBeyblade();
  ok('过期选择被清除（battleBbId=null）', g.battleBbId === null);
  ok('清除后回落战力最高', r === strong);

  // 合成台中央格兜底（背包空、仅靠中央格）
  // 注意：GameState 构造器会自动 load() 读存储；清掉前面 save 写入的脏数据，保证 g2 是干净新档
  for (const k in store) delete store[k];
  const g2 = new GameState();
  g2.platformSlots[1] = new Beyblade(2, 3);
  ok('背包空 + 中央格有 → 选中央格', g2.selectBattleBeyblade() === g2.platformSlots[1]);
}

console.log('\n【3】_findBbById 覆盖背包 + 合成台三槽');
{
  const g = new GameState();
  const a = new Beyblade(1, 2), b = new Beyblade(3, 4);
  g.inventory.push(a);
  g.platformSlots[0] = b;
  ok('背包内可按 id 找到', g._findBbById(a.id) === a);
  ok('合成台槽可按 id 找到', g._findBbById(b.id) === b);
  ok('未知 id 返回 null', g._findBbById('nope') === null);
  ok('id 唯一（同 tier+level 也不同 id）', new Beyblade(0, 1).id !== new Beyblade(0, 1).id);
}

console.log('\n【4】存档 round-trip：id + battleBbId 跨会话恢复');
{
  store['__test__'] = undefined; // 避免污染；save/load 用自身 STORAGE_KEY
  const g3 = new GameState();
  const sel = new Beyblade(4, 5);
  const other = new Beyblade(0, 1);
  g3.inventory.push(other, sel);
  g3.setBattleBeyblade(sel);
  g3.save(true); // 强制同步落盘到 wx 桩

  const g4 = new GameState();
  g4.load(); // 从 wx 桩读回
  ok('battleBbId 恢复一致', g4.battleBbId === sel.id);
  const restored = g4._findBbById(sel.id);
  ok('选中的陀螺 id 在加载后仍存在', !!restored);
  ok('恢复出的陀螺 id 与保存一致', restored && restored.id === sel.id);
  ok('选中的陀螺仍为最高战力之外（验证真是按 id 选中而非 power）', g4.battleBbId === sel.id && sel.power >= other.power);
}

console.log('\n【5】源码级接线：main.js 对战入口改开选陀螺面板');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
{
  ok('对战入口（battle）改调 _openBattleSelect', /a === 'battle'\)\s*\{[\s\S]{0,120}?_openBattleSelect\(\)/.test(mainSrc));
  ok('增益入口（buff）独立开增益面板（保留 buff 功能）', /a === 'buff'\)\s*\{[\s\S]{0,240}?buffOpen = true/.test(mainSrc));
  ok('V2 主「对战」按钮 battle_quick 分支也调 _openBattleSelect（修 action 错配回归）', /a === 'battle_quick'\)\s*\{[\s\S]*?_openBattleSelect\(\)/.test(mainSrc));
  ok('_openBattleSelect 方法已定义', /_openBattleSelect\(\)\s*\{/.test(mainSrc));
  ok('动作 battle_select_pick_ 前缀匹配分发', mainSrc.indexOf("a.indexOf('battle_select_pick_')") >= 0);
  ok('动作 battle_select_confirm 处理', mainSrc.indexOf("'battle_select_confirm'") >= 0);
  ok('动作 battle_select_close 处理', mainSrc.indexOf("'battle_select_close'") >= 0);
  ok('动作 battle_select_prev/next 翻页', mainSrc.indexOf("'battle_select_prev'") >= 0 && mainSrc.indexOf("'battle_select_next'") >= 0);
  ok('选中后调用 setBattleBeyblade 持久化', mainSrc.indexOf('setBattleBeyblade(bb)') >= 0);
  ok('「开始对战」统一走 _beginBattleWithSelected（其内直接开战）', mainSrc.indexOf('_beginBattleWithSelected()') >= 0 && /_beginBattleWithSelected\(\)\s*\{[\s\S]{0,400}?_confirmBattleBuff\(null\)/.test(mainSrc));
}

console.log('\n【6】源码级接线：render.js 选陀螺面板绘制 + 命中守卫');
const renderSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
{
  ok('drawBattleSelectPanel 方法已定义', /drawBattleSelectPanel\(\)\s*\{/.test(renderSrc));
  ok('render 门禁绘制面板', renderSrc.indexOf('if (this.game.battleSelectOpen) this.drawBattleSelectPanel();') >= 0);
  ok('hitTest 对 battleSelectOpen 只响应 modalRects（防误触穿透）',
    /if \(this\.game\.battleSelectOpen\)\s*\{[\s\S]*?for \(const m of this\.modalRects\)/.test(renderSrc));
  ok('行可点选：push battle_select_pick_ 动作', renderSrc.indexOf("action: 'battle_select_pick_' + bb.id") >= 0);
  ok('开始对战按钮：battle_select_confirm', renderSrc.indexOf("action: 'battle_select_confirm'") >= 0);
}

console.log('\n══════════════════════');
console.log((fail === 0 ? '✅' : '❌') + ' smoke_battle_select：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
