// P1 数据盲区：零成本埋点（微信小游戏「场景分析 / 分支曝光上报」）
// 验证：wx 缺失不崩 / 未配置 branchId 零上报 / boot 进程内一次 /
//       battle_start 携带 branchDim=stage（1-100 夹紧）/ first_battle_done 每用户一生一次。
// 运行：node tests/smoke_analytics.js   （聚合：node tests/run.js）

const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
}

function makeWx() {
  const calls = [];
  const store = {};
  const wx = {
    reportUserBehaviorBranchAnalytics: (p) => calls.push(p),
    getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : undefined),
    setStorageSync: (k, v) => { store[k] = v; }
  };
  return { wx, calls, store };
}

// 取一份干净的 analytics 模块（重置进程内 _bootFired），并注入指定 branchId
function freshAnalytics(branchIds) {
  const cfgPath = path.join(SRC, 'config.js');
  delete require.cache[require.resolve(cfgPath)];
  const cfg = require(cfgPath);
  cfg.CONFIG.analyticsBranch = branchIds || { boot: '', battleStart: '', firstBattleDone: '' };

  const p = path.join(SRC, 'analytics.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

// ===== A. wx 缺失 / API 缺失：静默不崩 =====
console.log('【A】wx 缺失或 API 缺失时不抛错（Node 无头安全）');
{
  const saved = global.wx;
  delete global.wx;
  const A = freshAnalytics({ boot: 'B1', battleStart: 'B2', firstBattleDone: 'B3' });
  let threw = false;
  try {
    A.reportBoot();
    A.reportBattleStart(1);
    A.reportFirstBattleDone();
  } catch (e) { threw = true; console.log('   err=' + e.message); }
  ok('wx 未定义时四个埋点不抛异常', !threw);

  // wx 存在但缺上报 API
  global.wx = {};
  let threw2 = false;
  try {
    const A2 = freshAnalytics({ boot: 'B1', battleStart: 'B2', firstBattleDone: 'B3' });
    A2.reportBoot(); A2.reportBattleStart(1); A2.reportFirstBattleDone();
  } catch (e) { threw2 = true; console.log('   err=' + e.message); }
  ok('wx 无 reportUserBehaviorBranchAnalytics 时不抛异常', !threw2);

  if (saved === undefined) delete global.wx; else global.wx = saved;
}

// ===== B. 正常上报：branchId / branchDim(stage) / 去重 / 一次性 =====
console.log('【B】伪造 wx：验证 branchId / branchDim(stage) / 去重 / 一次性');
const { wx, calls, store } = makeWx();
global.wx = wx;
const B = freshAnalytics({ boot: 'BR_BOOT', battleStart: 'BR_START', firstBattleDone: 'BR_FIRST' });

B.reportBattleStart(3);
{
  const last = calls[calls.length - 1];
  ok('battle_start 用正确 branchId', last && last.branchId === 'BR_START', JSON.stringify(last));
  ok('battle_start 携带 branchDim=3（String）', last && last.branchDim === '3', JSON.stringify(last));
  ok('battle_start eventType=1（曝光）', last && last.eventType === 1, JSON.stringify(last));
}

B.reportBattleStart(999);
{ const last = calls[calls.length - 1]; ok('stage=999 夹紧为 branchDim=100', last && last.branchDim === '100', JSON.stringify(last)); }
B.reportBattleStart(0);
{ const last = calls[calls.length - 1]; ok('stage=0 夹紧为 branchDim=1', last && last.branchDim === '1', JSON.stringify(last)); }

{
  const r1 = B.reportFirstBattleDone();
  const last = calls[calls.length - 1];
  ok('first_battle_done 首次返回 true', r1 === true);
  ok('first_battle_done 用正确 branchId', last && last.branchId === 'BR_FIRST', JSON.stringify(last));
  ok('首局完成去重标记写入存储', store[B.FIRST_DONE_KEY] === 1, JSON.stringify(store));
  const nBefore = calls.length;
  const r2 = B.reportFirstBattleDone();
  ok('first_battle_done 二次返回 false（去重）', r2 === false);
  ok('去重后不再重复上报', calls.length === nBefore, 'Δ=' + (calls.length - nBefore));
}

{
  B.reportBoot();
  const n1 = calls.filter(c => c.branchId === 'BR_BOOT').length;
  ok('boot 首次上报', n1 === 1, 'n=' + n1);
  B.reportBoot();
  const n2 = calls.filter(c => c.branchId === 'BR_BOOT').length;
  ok('boot 进程内仅一次（二次不重复）', n2 === 1, 'n=' + n2);
}

// ===== C. 未配置 branchId：完全不上报、不写去重 =====
console.log('【C】branchId 留空时不产生任何上报');
{
  const { wx: wxC, calls: callsC, store: storeC } = makeWx();
  global.wx = wxC;
  const C = freshAnalytics({ boot: '', battleStart: '', firstBattleDone: '' });
  C.reportBoot();
  C.reportBattleStart(5);
  C.reportFirstBattleDone();
  ok('空 branchId 时零次上报', callsC.length === 0, 'n=' + callsC.length);
  ok('空 branchId 时不写去重存储', !Object.prototype.hasOwnProperty.call(storeC, C.FIRST_DONE_KEY));
}

// ===== D. U10 新增 5 个漏斗：维度夹紧 / branchId 路由 =====
console.log('【D】U10 新增漏斗：draw/merge/defeat/share/ad 维度与 branchId 路由');
{
  const { wx: wxD, calls: callsD } = makeWx();
  global.wx = wxD;
  const D = freshAnalytics({
    boot: '', battleStart: '', firstBattleDone: '',
    draw: 'BR_DRAW', merge: 'BR_MERGE', battleDefeat: 'BR_DEF',
    share: 'BR_SHARE', adWatch: 'BR_AD'
  });
  D.reportDraw(4);
  { const l = callsD[callsD.length - 1]; ok('draw 稀有度 tier=4 → branchDim 5', l && l.branchId === 'BR_DRAW' && l.branchDim === '5', JSON.stringify(l)); }
  D.reportDraw(0);
  { const l = callsD[callsD.length - 1]; ok('draw 稀有度 tier=0 → branchDim 1', l && l.branchDim === '1', JSON.stringify(l)); }
  D.reportDraw(2);
  { const l = callsD[callsD.length - 1]; ok('draw 稀有度 tier=2 → branchDim 3', l && l.branchDim === '3', JSON.stringify(l)); }

  D.reportMerge(3);
  { const l = callsD[callsD.length - 1]; ok('merge 产物 tier=3 → branchDim 4', l && l.branchId === 'BR_MERGE' && l.branchDim === '4', JSON.stringify(l)); }

  D.reportBattleDefeat(15);
  { const l = callsD[callsD.length - 1]; ok('defeat stage=15 → branchDim 15', l && l.branchId === 'BR_DEF' && l.branchDim === '15', JSON.stringify(l)); }
  D.reportBattleDefeat(0);
  { const l = callsD[callsD.length - 1]; ok('defeat stage=0 → 夹紧 1', l && l.branchDim === '1', JSON.stringify(l)); }
  D.reportBattleDefeat(999);
  { const l = callsD[callsD.length - 1]; ok('defeat stage=999 → 夹紧 100', l && l.branchDim === '100', JSON.stringify(l)); }

  D.reportShare();
  { const l = callsD[callsD.length - 1]; ok('share 无维度 branchDim 空', l && l.branchId === 'BR_SHARE' && l.branchDim === '', JSON.stringify(l)); }
  D.reportAdWatch();
  { const l = callsD[callsD.length - 1]; ok('adWatch 无维度 branchDim 空', l && l.branchId === 'BR_AD' && l.branchDim === '', JSON.stringify(l)); }
}

// ===== E. 新增漏斗：空 branchId 完全不上报 =====
console.log('【E】新增漏斗 branchId 留空时零上报');
{
  const { wx: wxE, calls: callsE } = makeWx();
  global.wx = wxE;
  const E = freshAnalytics({ boot: '', battleStart: '', firstBattleDone: '', draw: '', merge: '', battleDefeat: '', share: '', adWatch: '' });
  E.reportDraw(4); E.reportMerge(1); E.reportBattleDefeat(3); E.reportShare(); E.reportAdWatch();
  ok('空 branchId 时 5 个新漏斗零上报', callsE.length === 0, 'n=' + callsE.length);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
