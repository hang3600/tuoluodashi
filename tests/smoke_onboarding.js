#!/usr/bin/env node
'use strict';
// ============================================================
// 首程直达轻引导（2026-09-04）回归测试
// 背景：IAA 诊断显示首分钟流失 61%、首日时长 2.1min（标杆 12.9min），
//       根因是玩法释放速度。本套件锁定 2 步轻引导状态机：
//       新档无陀螺 → obStep1 高亮抽卡 → 抽到 → obStep2 高亮对战 → 首胜收起。
// 断言覆盖：
//   1) 状态机转移（新档/抽卡后/首胜/连败兜底/幂等）
//   2) 存档 roundtrip（obDone/obTries 持久化）
//   3) 老档兼容（level>1 无 obDone 字段 → 不误触发）
//   4) obStep 推导依赖 inventory（空包→1，有货→2）
//   5) render 源码级：_drawObGlow 存在、无全屏遮罩（不复活被砍的引导形态）、两处布局均调用
// ============================================================
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail !== undefined ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ❌ ' + name + (detail !== undefined ? '  [' + detail + ']' : '')); }
}

// ── wx 桩：最小存档能力（供 save/load roundtrip）────────────
const store = {};
global.wx = {
  setStorageSync: function (k, v) { store[k] = v; },
  getStorageSync: function (k) { return store[k]; }
};

const { GameState } = require(path.join(SRC, 'game.js'));

console.log('\n【A】状态机：新档 → 抽卡 → 对战 → 首胜收起');
{
  const g = new GameState();
  ok('A1 新档 obStep=1（引导抽卡）', g.obStep === 1, 'obStep=' + g.obStep);
  ok('A2 新档 obDone=false / obTries=0', g.obDone === false && g.obTries === 0);

  const bb = g.draw(false); // 能量抽卡（初始 150 ≥ 8）
  ok('A3 draw() 成功产出陀螺', !!bb);
  ok('A4 抽到第一只 → obStep=2（引导对战）', g.obStep === 2, 'obStep=' + g.obStep);

  const r1 = g.onBattleEnd(true);
  ok('A5 首胜 → onBattleEnd 返回 true（收起）', r1 === true);
  ok('A6 首胜后 obDone=true / obStep=0', g.obDone === true && g.obStep === 0);

  const r2 = g.onBattleEnd(true);
  ok('A7 obDone 后再调幂等返回 false', r2 === false && g.obDone === true);
}

console.log('\n【B】连败兜底：败 2 场保留，第 3 场强制收起');
{
  const g = new GameState();
  g.draw(false);
  const r1 = g.onBattleEnd(false);
  ok('B1 败 1 场未收起', r1 === false && g.obDone === false && g.obTries === 1, 'tries=' + g.obTries);
  const r2 = g.onBattleEnd(false);
  ok('B2 败 2 场未收起（仍引导再战）', r2 === false && g.obDone === false && g.obStep === 2, 'tries=' + g.obTries);
  const r3 = g.onBattleEnd(false);
  ok('B3 败 3 场兜底强制收起', r3 === true && g.obDone === true && g.obStep === 0, 'tries=' + g.obTries);
  ok('B4 收起后 obTries 不再增长', g.onBattleEnd(false) === false && g.obTries === 3);
}

console.log('\n【C】存档 roundtrip：obDone/obTries 持久化');
{
  const g = new GameState();
  g.draw(false);
  g.onBattleEnd(true);
  g.obTries = 2; // 模拟历史上曾连败（虽已收起，tries 应随档保留）
  g.save(true);

  const g2 = new GameState();
  g2.load();
  ok('C1 load 后 obDone=true（已收起不复发）', g2.obDone === true);
  ok('C2 load 后 obStep=0', g2.obStep === 0, 'obStep=' + g2.obStep);
  ok('C3 load 后 obTries=2（随档保留）', g2.obTries === 2, 'tries=' + g2.obTries);
}

console.log('\n【D】老档兼容：level>1 无 obDone 字段 → 视为已完成，不误触发');
{
  // 模拟老玩家存档：有等级有背包，但没有 obDone/obTries 字段
  const legacy = {
    schema: 1, coins: 500, energy: 100, maxEnergy: 150, level: 3, exp: 300,
    inventory: [{ tierIndex: 2, level: 2 }], collection: [], platform: [],
    tutorialDone: true, tutorialStep: 2
  };
  store['__ob_legacy__'] = JSON.stringify(legacy);
  const g = new GameState();
  // 用内部 STORAGE_KEY 不可达 → 直接喂 data 走 load 的字段恢复段：通过 getStorageSync 桩拦截
  // （load 内部 key 是模块常量；这里用 hack：临时把桩 store 的真实键补上）
  // 更稳的方式：观察 load 后行为。
  // 由于 load 只读自己的 STORAGE_KEY，这里改为构造「真实键」：从 save(true) 写入的键反查。
  const keys = Object.keys(store);
  for (const k of keys) delete store[k];
  // 用一个真档 save 一次以获得真实键名
  const probe = new GameState();
  probe.save(true);
  const realKey = Object.keys(store)[0];
  ok('D0 探针：拿到真实存档键', !!realKey, realKey || '(无)');
  store[realKey] = JSON.stringify(legacy);

  const g2 = new GameState();
  g2.load();
  ok('D1 老档 level=3 → obDone=true（不误触发）', g2.obDone === true);
  ok('D2 老档 obStep=0（无光圈）', g2.obStep === 0);
}

console.log('\n【E】obStep 推导依赖 inventory（load 后）');
{
  // 新档（level=1、无 obDone、背包空）→ obStep=1
  const fresh = { schema: 1, coins: 0, energy: 150, maxEnergy: 150, level: 1, exp: 0, inventory: [], collection: [], platform: [] };
  const probe = new GameState();
  probe.save(true);
  const realKey = Object.keys(store)[0];
  store[realKey] = JSON.stringify(fresh);
  const g = new GameState();
  g.load();
  ok('E1 空包新档 → obStep=1（引导抽卡）', g.obStep === 1 && g.obDone === false);

  fresh.inventory = [{ tierIndex: 0, level: 1 }];
  store[realKey] = JSON.stringify(fresh);
  const g2 = new GameState();
  g2.load();
  ok('E2 有货新档 → obStep=2（引导对战）', g2.obStep === 2 && g2.obDone === false);
}

console.log('\n【F】render 源码级：轻引导不打断、两处布局均接入');
{
  const src = fs.readFileSync(path.join(SRC, 'render.js'), 'utf8');
  ok('F1 _drawObGlow 方法存在', src.indexOf('_drawObGlow()') >= 0);
  ok('F2 obDone 守卫（收起后永不绘制）', /_drawObGlow\(\)\s*\{[\s\S]{0,200}obDone/.test(src));
  ok('F3 mode!==main 守卫（对战中不绘制）', /_drawObGlow\(\)\s*\{[\s\S]{0,240}mode\s*!==\s*'main'/.test(src));
  // 精确截取 _drawObGlow 方法体：从「_drawObGlow() {」到紧邻的下一个方法「drawTutorial() {」
  const ioDef = src.indexOf('_drawObGlow() {');
  const itNext = src.indexOf('drawTutorial() {', ioDef);
  const glowBody = src.slice(ioDef, itNext);
  ok('F4 无全屏遮罩（不复活被砍的引导形态）', glowBody.indexOf('PANEL_MASK') < 0 && !/fillRect\(\s*0\s*,\s*0\s*,\s*\w+\s*,\s*\w+\s*\)/.test(glowBody));
  // 两处主页布局末尾均调用 _drawObGlow（V2 drawHomeActions + 旧 drawActionBar）；方法定义不计入调用点
  const calls = src.split('_drawObGlow();').length - 1;
  ok('F5 _drawObGlow 两处布局调用点 = 2', calls === 2, 'calls=' + calls);

  const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  ok('F6 main.js 对战结算调用 onBattleEnd', mainSrc.indexOf('onBattleEnd(this.game.battle.result') >= 0);
  ok('F7 main.js 调用点唯一（_resultPlayed 块内，避免复活重战误收）', (mainSrc.match(/onBattleEnd\(/g) || []).length === 1);

  const gameSrc = fs.readFileSync(path.join(SRC, 'game.js'), 'utf8');
  ok('F8 draw() 成功后推进 obStep 1→2', gameSrc.indexOf("this.obStep === 1) this.obStep = 2") >= 0);
  ok('F9 存档含 obDone/obTries', gameSrc.indexOf('obDone: this.obDone') >= 0 && gameSrc.indexOf('obTries: this.obTries') >= 0);
}

// 还原全局
if (global.wx) delete global.wx;

console.log('\n' + '═'.repeat(40));
if (fail === 0) console.log('✅ 首程引导套件：通过 ' + pass + ' / 失败 0');
else console.log('❌ 首程引导套件：通过 ' + pass + ' / 失败 ' + fail);
console.log('═'.repeat(40) + '\n');
process.exit(fail === 0 ? 0 : 1);
