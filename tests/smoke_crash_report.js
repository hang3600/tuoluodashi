/**
 * 生产崩溃上报（运维中心，零后端）回归套件
 * ==========================================================================
 * 守护 P1 稳定性缺口：error-handler 已捕获未捕获异常，但缺「远端/持久化落点」。
 * 本套件断言 capture() 现在会把崩溃写进：
 *   1) 小游戏实时日志（wx.getGameLogManager，全量 errorLog）
 *   2) 计数事件（wx.reportEvent(eventId, {source})，基础库 ≥2.31.1；
 *      无 reportEvent 的旧 Lib 回退 wx.reportMonitor）
 * 并守住防御边界：
 *   - devtools 环境：两者都跳过，不污染生产监控
 *   - eventId 留空：只走实时日志，不上报计数
 *   - 上报链路自身抛错：绝不反噬主流程（capture 不向外抛）
 *   - wx 缺失：静默跳过，不崩
 *
 * 实现链路（已落地，本套件仅做断言守护，防回退）：
 *   src/error-handler.js: init({ report:{gameLog,eventId} })
 *     → capture() 末尾调 _reportCrash(errorLog)
 *       → _isDevtools() 守卫（devtools 直接 return）
 *       → _getLogManager() 懒取 wx.getGameLogManager()，lm.error/warn 写全量
 *       → eventId 非空且 wx.reportEvent 存在 → reportEvent(eventId,{crash_count:1})
 *         （否则回退 reportMonitor(eventId,1)）
 *   src/main.js:172 传入 report: CONFIG.crashReport
 *   src/config.js: CONFIG.crashReport = { gameLog:true, eventId:'' }
 */
const path = require('path');
const { ErrorHandlerClass } = require(path.join(__dirname, '..', 'src', 'error-handler'));

let pass = 0, fail = 0;
function ok(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + desc + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + desc + (extra ? ' — ' + extra : '')); }
}

// ── mock 工厂：按平台/配置返回一套 wx 桩，并记录实时日志与事件/监控调用 ──
function makeWx(platform, opts) {
  opts = opts || {};
  const logCalls = { error: [], warn: [], info: [] };
  const eventCalls = [];     // wx.reportEvent 调用记录（主路径）
  const monitorCalls = [];   // wx.reportMonitor 调用记录（旧基础库兜底）
  const onErrorCbs = [];
  const wx = {
    platform,
    getSystemInfoSync: () => ({
      platform,
      system: 'iOS 17.0',
      model: 'iPhone14,5',
      version: '8.0.50',
      SDKVersion: '3.17.1',
      benchmarkLevel: 80,
      devicePixelRatio: 3,
      screenWidth: 1170,
      screenHeight: 2532
    }),
    onError: (cb) => { onErrorCbs.push(cb); },
    getGameLogManager: opts.noLogManager
      ? undefined
      : () => ({
          error: (m) => { logCalls.error.push(String(m)); },
          warn: (m) => { logCalls.warn.push(String(m)); },
          info: (m) => { logCalls.info.push(String(m)); },
          log: (m) => { logCalls.info.push(String(m)); }
        }),
    reportEvent: opts.noReportEvent
      ? undefined
      : (id, data) => { eventCalls.push([id, data]); },
    reportMonitor: opts.noReportMonitor
      ? undefined
      : (name, value) => { monitorCalls.push([name, value]); }
  };
  return { wx, logCalls, eventCalls, monitorCalls, onErrorCbs };
}

function fakeGame() {
  return {
    coins: 120, energy: 30, maxEnergy: 50, inventory: new Array(5),
    platformSlots: [null, { tierIndex: 2, level: 3 }, null], level: 7, exp: 400,
    winStreak: 2, arenaPts: 1500, mergeCount: 10, signDay: 3, dailyActive: true
  };
}

// ═══════════════════════════════════════════════════════════════
// 场景 1：真机(ios) + eventId 配置 → 实时日志 + 计数事件 都触发
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 1：真机 + eventId → 实时日志 + 计数事件 ═══\n');
{
  const { wx, logCalls, eventCalls } = makeWx('ios');
  global.wx = wx;
  const h = new ErrorHandlerClass();
  h.init({ gameState: fakeGame(), report: { gameLog: true, eventId: 'CRASH_BB_001' } });
  let threw = false, ret = null;
  try { ret = h.capture(new Error('boom in render'), 'render'); } catch (e) { threw = true; }
  ok('capture 不向外抛异常', !threw);
  ok('capture 返回 errorLog', ret && ret.source === 'render' && /boom in render/.test(ret.message));
  ok('实时日志 error 写了崩溃头([crash] source | message)',
    logCalls.error.length >= 1 && /\[crash\] render \| boom in render/.test(logCalls.error[0]));
  ok('实时日志 error 写了堆栈', logCalls.error.length >= 2 && /at /.test(logCalls.error[1]));
  ok('实时日志 warn 写了 device + gameState 摘要',
    logCalls.warn.length >= 1 && /device=/.test(logCalls.warn[0]) && /state=/.test(logCalls.warn[0]));
  ok('计数事件 reportEvent 被调用(CRASH_BB_001, source=render)',
    eventCalls.length === 1 && eventCalls[0][0] === 'CRASH_BB_001' &&
    eventCalls[0][1] && eventCalls[0][1].source === 'render',
    JSON.stringify(eventCalls));
  delete global.wx;
}

// ═══════════════════════════════════════════════════════════════
// 场景 2：真机 + eventId 留空 → 只走实时日志，不上报计数
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 2：真机 + eventId 留空 → 仅实时日志 ═══\n');
{
  const { wx, logCalls, eventCalls } = makeWx('android');
  global.wx = wx;
  const h = new ErrorHandlerClass();
  h.init({ gameState: fakeGame(), report: { gameLog: true, eventId: '' } });
  h.capture(new Error('oops'), 'mainLoop');
  ok('仍有实时日志(error 写了崩溃头)', logCalls.error.length >= 1);
  ok('eventId 留空 → reportEvent 未被调用', eventCalls.length === 0, JSON.stringify(eventCalls));
  delete global.wx;
}

// ═══════════════════════════════════════════════════════════════
// 场景 2b：旧基础库无 reportEvent → 回退 reportMonitor（保险）
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 2b：无 reportEvent → 回退 reportMonitor ═══\n');
{
  const { wx, eventCalls, monitorCalls } = makeWx('ios', { noReportEvent: true });
  global.wx = wx;
  const h = new ErrorHandlerClass();
  h.init({ gameState: fakeGame(), report: { gameLog: true, eventId: 'CRASH_BB_001' } });
  h.capture(new Error('legacy'), 'render');
  ok('无 reportEvent → 回退 reportMonitor(eventId, 1)',
    eventCalls.length === 0 && monitorCalls.length === 1 &&
    monitorCalls[0][0] === 'CRASH_BB_001' && monitorCalls[0][1] === 1,
    JSON.stringify(monitorCalls));
  delete global.wx;
}

// ═══════════════════════════════════════════════════════════════
// 场景 3：devtools 环境 → 两者都跳过，不污染生产监控
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 3：devtools → 跳过运维中心上报 ═══\n');
{
  const { wx, logCalls, eventCalls } = makeWx('devtools');
  global.wx = wx;
  const h = new ErrorHandlerClass();
  h.init({ gameState: fakeGame(), report: { gameLog: true, eventId: 'CRASH_BB_001' } });
  h.capture(new Error('devtools boom'), 'render');
  ok('devtools 下实时日志未写', logCalls.error.length === 0 && logCalls.warn.length === 0);
  ok('devtools 下 reportEvent 未调用', eventCalls.length === 0);
  ok('devtools 下 capture 仍正常返回 errorLog', true);
  delete global.wx;
}

// ═══════════════════════════════════════════════════════════════
// 场景 4：上报链路自身抛错 → 不反噬主流程
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 4：上报链路抛错→ 不反噬 ═══\n');
{
  const { wx } = makeWx('ios');
  // 让实时日志 error 抛错，模拟底层写入故障
  wx.getGameLogManager = () => ({
    error: () => { throw new Error('log write failed'); },
    warn: () => { throw new Error('log write failed'); },
    info: () => {}, log: () => {}
  });
  global.wx = wx;
  const h = new ErrorHandlerClass();
  h.init({ gameState: fakeGame(), report: { gameLog: true, eventId: 'CRASH_MON_001' } });
  let threw = false, ret = null;
  try { ret = h.capture(new Error('inner fail'), 'input'); } catch (e) { threw = true; }
  ok('实时日志写入故障不向外抛', !threw);
  ok('仍返回 errorLog（捕获成功）', ret && ret.source === 'input');
  delete global.wx;
}

// ═══════════════════════════════════════════════════════════════
// 场景 5：wx 缺失（无头/极端环境）→ 静默跳过，不崩
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 5：wx 缺失 → 静默不崩 ═══\n');
{
  delete global.wx;
  const h = new ErrorHandlerClass();
  let threw = false;
  try {
    h.init({ gameState: fakeGame(), report: { gameLog: true, eventId: 'X' } });
    h.capture(new Error('no wx'), 'render');
  } catch (e) { threw = true; }
  ok('wx 缺失下 init/ capture 不抛', !threw);
}

// ═══════════════════════════════════════════════════════════════
// 场景 6：wrap / wrapAsync 抛错 → 路由进 capture（闭环验证）
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 6：wrap/wrapAsync → 进 capture ═══\n');
(async () => {
  const { wx, logCalls } = makeWx('ios');
  global.wx = wx;
  const h = new ErrorHandlerClass();
  h.init({ gameState: fakeGame(), report: { gameLog: true, eventId: '' } });

  // 同步 wrap
  const syncFn = h.wrap(() => { throw new Error('wrapped sync boom'); }, 'wrapped');
  syncFn();
  ok('wrap 抛错 → 实时日志收到(wrapped)', logCalls.error.some(m => /wrapped/.test(m)));

  // 异步 wrapAsync
  let threw = false;
  try {
    const asyncFn = h.wrapAsync(async () => { throw new Error('wrapped async boom'); }, 'wrappedAsync');
    await asyncFn();
  } catch (e) { threw = true; }
  ok('wrapAsync 抛错 → 不向上抛（被 capture 吞掉）', !threw);
  ok('wrapAsync 抛错 → 实时日志收到(wrappedAsync)', logCalls.error.some(m => /wrappedAsync/.test(m)));
  delete global.wx;

  // ── 源码级守护：确认 main.js 已传入 report 且删掉了冗余 wx.onError ──
  console.log('\n═══ 场景 7：源码级守护（main.js 接线 + 删冗余）═══\n');
  const SRC = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  ok('main.js init 传入 report: CONFIG.crashReport',
    /ErrorHandler\.init\([\s\S]*?report:\s*CONFIG\.crashReport/.test(SRC));
  ok('main.js 不再注册第二个裸 wx.onError（避免覆盖/重复）',
    !/wx\.onError\(\(err\) => \{ console\.error\('\[global\]'/.test(SRC));

  const CFG = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  ok('config.js 有 CONFIG.crashReport', /crashReport\s*:\s*\{/.test(CFG));
  ok('crashReport.gameLog 默认 true', /gameLog\s*:\s*true/.test(CFG));

  console.log('\n' + '═'.repeat(40));
  if (fail === 0) console.log('✅ 崩溃上报套件：通过 ' + pass + ' / 失败 0');
  else console.log('❌ 崩溃上报套件：通过 ' + pass + ' / 失败 ' + fail);
  console.log('═'.repeat(40) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})();
