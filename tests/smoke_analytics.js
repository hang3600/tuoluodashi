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

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
