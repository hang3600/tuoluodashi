// 冒烟套件 —— P0-1 生死漏斗（启动→首抽→首战→首胜→D1回访）
//
// 锁定行为：
//   ① 五步漏斗 each once-per-install（storage 去重，重复调用不重复计数）；
//   ② D1 回访判定：安装日恰好是昨天才上报，安装当天/隔 2 天以上都不算；
//   ③ 通道 = wx.reportEvent（事件名 bb_funnel_*，统一 {count:1}）；
//   ④ 无 wx / 无 API → 静默 no-op，不抛错；
//   ⑤ 触发点接线（源码级）：boot+D1 在 main 构造、首抽在 game.draw、
//      首战在 main._startBattle（全部开战路径唯一入口）、首胜在 spintop._settle 胜利分支。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

function localDayKey(offsetDays) {
  const n = new Date();
  const t = new Date(n.getFullYear(), n.getMonth(), n.getDate() + offsetDays);
  const m = t.getMonth() + 1, d = t.getDate();
  return t.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
}

// 每个场景用独立 storage + 重新 require analytics，保证去重状态干净
function freshAnalytics(store) {
  const events = [];
  global.wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v; },
    reportEvent: (name, data) => { events.push({ name, data }); }
  };
  jest_reset();
  function jest_reset() {
    const p = require.resolve(path.join(SRC, 'analytics.js'));
    if (require.cache[p]) delete require.cache[p];
  }
  const analytics = require(path.join(SRC, 'analytics.js'));
  return { analytics, events };
}

console.log('\n【1】五步漏斗 once-per-install：重复调用不重复上报');
{
  const store = {};
  const { analytics, events } = freshAnalytics(store);
  analytics.reportFunnelBoot();
  analytics.reportFunnelBoot();   // 重复
  analytics.reportFunnelFirstDraw();
  analytics.reportFunnelFirstDraw(); // 重复
  analytics.reportFunnelFirstBattle();
  analytics.reportFunnelFirstBattle(); // 重复
  analytics.reportFunnelFirstWin();
  analytics.reportFunnelFirstWin(); // 重复
  ok('boot 仅 1 次', events.filter(e => e.name === 'bb_funnel_boot').length === 1);
  ok('first_draw 仅 1 次', events.filter(e => e.name === 'bb_funnel_first_draw').length === 1, JSON.stringify(events));
  ok('first_battle 仅 1 次', events.filter(e => e.name === 'bb_funnel_first_battle').length === 1);
  ok('first_win 仅 1 次', events.filter(e => e.name === 'bb_funnel_first_win').length === 1);
  ok('事件名前缀正确', events.every(e => e.name.indexOf('bb_funnel_') === 0), JSON.stringify(events.map(e => e.name)));
  ok('统一 {count:1} 维度', events.every(e => e.data && e.data.count === 1));
}

console.log('\n【2】D1 回访判定：昨天安装 → 今日上报一次；当天/隔 2 天 → 不报');
{
  // 昨天安装 → D1
  let store = { bb_install_day: localDayKey(-1) };
  let { analytics, events } = freshAnalytics(store);
  const r1 = analytics.reportFunnelD1Return();
  const r2 = analytics.reportFunnelD1Return(); // 重复调用
  ok('安装日=昨天 → 上报 D1', r1 === true && events.filter(e => e.name === 'bb_funnel_d1_return').length === 1);
  ok('重复调用去重', r2 === false && events.length === 1);

  // 安装当天 → 不算回访
  store = { bb_install_day: localDayKey(0) };
  ({ analytics, events } = freshAnalytics(store));
  ok('安装当天启动 → 不上报', analytics.reportFunnelD1Return() === false);

  // 隔 2 天才回 → 不算 D1
  store = { bb_install_day: localDayKey(-2) };
  ({ analytics, events } = freshAnalytics(store));
  ok('隔 2 天回流 → 不上报 D1', analytics.reportFunnelD1Return() === false);

  // 无安装日记录（首次启动）→ 记录安装日且不上报
  store = {};
  ({ analytics, events } = freshAnalytics(store));
  ok('首次启动记录安装日', analytics.reportFunnelD1Return() === false && !!store.bb_install_day);
}

console.log('\n【3】无 wx / 无 reportEvent → 静默 no-op 不抛错');
{
  const savedWx = global.wx;
  try {
    global.wx = undefined;
    const p = require.resolve(path.join(SRC, 'analytics.js'));
    if (require.cache[p]) delete require.cache[p];
    const analytics = require(path.join(SRC, 'analytics.js'));
    let threw = null;
    try {
      analytics.reportFunnelBoot();
      analytics.reportFunnelFirstDraw();
      analytics.reportFunnelFirstBattle();
      analytics.reportFunnelFirstWin();
      analytics.reportFunnelD1Return();
    } catch (e) { threw = e.message; }
    ok('无 wx 不抛错', threw === null, threw);
  } finally {
    global.wx = savedWx;
  }
}

console.log('\n【4】触发点接线（源码级）');
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const gameSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'game.js'), 'utf8');
  const spintopSrc = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  ok('main 构造：reportFunnelBoot + reportFunnelD1Return', /reportFunnelBoot\(\)/.test(mainSrc) && /reportFunnelD1Return\(\)/.test(mainSrc));
  ok('main._startBattle：首战漏斗（全部开战路径唯一入口）',
    /_startBattle\(bb, buff, opts\)\s*\{[\s\S]*?reportFunnelFirstBattle\(\)/.test(mainSrc));
  ok('game.draw：首抽漏斗', /reportFunnelFirstDraw\(\)/.test(gameSrc));
  ok('spintop._settle 胜利分支：首胜漏斗',
    /winStreak \+= 1;[\s\S]{0,300}reportFunnelFirstWin\(\)/.test(spintopSrc));
}

console.log('\n────────────────────────');
console.log('P0-1 结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
