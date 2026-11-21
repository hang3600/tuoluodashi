// 冒烟套件 —— 留存 P0：订阅消息封装 + 启动期自动弹签到纯判定 + main 接线门禁
// 路径相对化：无论从哪个目录调用，都基于本文件位置定位 src/
process.env.TZ = 'Asia/Shanghai';

const path = require('path');
const fs = require('fs');
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { Subscribe } = require(path.join(SRC_DIR, 'subscribe.js'));
const { CONFIG } = require(path.join(SRC_DIR, 'config.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

// 冻结本地时间
function freeze(y, mo, d, h, mi) {
  const fixed = new Date(y, mo - 1, d, h || 0, mi || 0, 0).getTime();
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}
function unfreeze() { global.Date = require('vm').runInThisContext('Date'); }

console.log('\n【1】autoSignAvailable 纯判定（无副作用，不调用 canSign）');
{
  const g = new GameState();
  freeze(2026, 9, 4, 10, 0);
  ok('新档且离线弹窗关 → 可自动弹签到', g.autoSignAvailable() === true);
  const beforeDate = g.signDate, beforeClaimed = g.signClaimed, beforeStreak = g.signStreak;
  g.autoSignAvailable(); // 连续调用不应改变任何状态字段
  ok('调用 autoSignAvailable 不推进 signDate', g.signDate === beforeDate, 'signDate ' + beforeDate + '→' + g.signDate);
  ok('调用 autoSignAvailable 不改 signClaimed', g.signClaimed === beforeClaimed);
  ok('调用 autoSignAvailable 不改 signStreak', g.signStreak === beforeStreak);
  unfreeze();
}

console.log('\n【2】autoSignAvailable 与「今日已签 / 回归弹窗」互斥');
{
  const g = new GameState();
  freeze(2026, 9, 4, 10, 0);
  g.checkIn(); // 今日已签到
  ok('今日已签到 → autoSignAvailable 为 false', g.autoSignAvailable() === false);
  unfreeze();
}
{
  const g = new GameState();
  freeze(2026, 9, 4, 10, 0);
  g.offlineOpen = true; // 回归弹窗优先，避免浮层叠加
  ok('有回归弹窗 → autoSignAvailable 为 false', g.autoSignAvailable() === false);
  unfreeze();
}
{
  const g = new GameState();
  freeze(2026, 9, 2, 10, 0);
  g.signDate = '2026-09-02'; g.signClaimed = true; // 模拟两天前已签
  unfreeze();
  freeze(2026, 9, 4, 10, 0);
  ok('隔日未签 → 又可自动弹', g.autoSignAvailable() === true);
  unfreeze();
}

console.log('\n【3】Subscribe.request 安全降级（无 wx / 无 API / 模板未配）');
{
  const savedWx = global.wx;
  const savedDaily = CONFIG.subscribeTemplates.daily;
  const savedEnergy = CONFIG.subscribeTemplates.energy;
  const savedOffline = CONFIG.subscribeTemplates.offline;
  // 显式清空所有模板 ID，模拟「未配」：与 config 当前是否已填真实 ID 解耦，保证断言确定性
  CONFIG.subscribeTemplates.daily = '';
  CONFIG.subscribeTemplates.energy = '';
  CONFIG.subscribeTemplates.offline = '';
  delete global.wx;
  ok('无 wx → request 返回 false 且不抛', Subscribe.request(['daily']) === false);
  global.wx = {};
  ok('wx 无 requestSubscribeMessage → 返回 false', Subscribe.request(['daily']) === false);
  let called = false;
  global.wx = { requestSubscribeMessage: function () { called = true; } };
  ok('模板未配 → request 返回 false 且不调用微信', Subscribe.request(['daily']) === false && called === false);
  // 还原 config（防污染后续用例）/ wx
  CONFIG.subscribeTemplates.daily = savedDaily;
  CONFIG.subscribeTemplates.energy = savedEnergy;
  CONFIG.subscribeTemplates.offline = savedOffline;
  global.wx = savedWx;
}

console.log('\n【4】Subscribe.request 配置就位后真正发出（且只发已配的 ID）');
{
  const savedWx = global.wx;
  const savedDaily = CONFIG.subscribeTemplates.daily;
  const savedOffline = CONFIG.subscribeTemplates.offline;
  CONFIG.subscribeTemplates.daily = 'tmpl_daily_123';
  CONFIG.subscribeTemplates.offline = 'tmpl_offline_456';
  let captured = null;
  global.wx = {
    requestSubscribeMessage: function (arg) { captured = arg; if (arg && arg.success) arg.success({ tmpl_daily_123: 'accept' }); }
  };
  ok('模板已配 → request 返回 true', Subscribe.request(['daily', 'offline']) === true);
  ok('调用微信 tmplIds 含 daily+offline（仅已配）',
    captured && Array.isArray(captured.tmplIds) && captured.tmplIds.length === 2 &&
    captured.tmplIds.indexOf('tmpl_daily_123') >= 0 && captured.tmplIds.indexOf('tmpl_offline_456') >= 0,
    JSON.stringify(captured && captured.tmplIds));
  captured = null;
  Subscribe.request(['daily']);
  ok('只传 daily → tmplIds 仅含 daily',
    captured && captured.tmplIds.length === 1 && captured.tmplIds[0] === 'tmpl_daily_123',
    JSON.stringify(captured && captured.tmplIds));
  // 还原 config（防污染其它套件）
  CONFIG.subscribeTemplates.daily = savedDaily;
  CONFIG.subscribeTemplates.offline = savedOffline;
  global.wx = savedWx;
}

console.log('\n【5】main.js 接线存在性（源码级门禁，防回退）');
{
  const mainSrc = fs.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8');
  ok('main.js 引入 Subscribe 封装', mainSrc.indexOf("require('./subscribe')") >= 0);
  ok('已移除启动期强制弹签到（main.js 不再调用 autoSignAvailable）', mainSrc.indexOf('autoSignAvailable()') < 0);
  ok('手动签到按钮打开签到面板(signin→signOpen=true)', mainSrc.indexOf("'signin'") >= 0 && mainSrc.indexOf('signOpen = true') >= 0);
  ok('签到成功后触发订阅请求(daily)', mainSrc.indexOf("_maybePromptSubscribe(['daily'])") >= 0);
  ok('回归领奖后触发订阅请求(daily+offline)', mainSrc.indexOf("_maybePromptSubscribe(['daily', 'offline'])") >= 0);
  ok('看广告得能量后触发订阅请求(energy)', mainSrc.indexOf("_maybePromptSubscribe(['energy'])") >= 0);
  ok('_maybePromptSubscribe 按类型分别守卫(防重复骚扰)', mainSrc.indexOf('_subscribedTypes') >= 0);
  // 首页签到按钮红点/高亮（非强制弹窗，仅提示）由 autoSignAvailable 驱动
  const renderSrc = fs.readFileSync(path.join(SRC_DIR, 'render.js'), 'utf8');
  // P2-6 福利中心（2026-10-31）：签到按钮升级为「福利」单入口，红点由 welfareMeta().anyDue 驱动
  ok('首页福利按钮红点由 welfareMeta 驱动（非强制弹窗）', renderSrc.indexOf('welfareMeta') >= 0 && renderSrc.indexOf('anyDue') >= 0);
}

console.log('\n【6】config 提供 subscribeTemplates 占位（MP 后台申请说明）');
{
  const cfgSrc = fs.readFileSync(path.join(SRC_DIR, 'config.js'), 'utf8');
  ok('CONFIG.subscribeTemplates 含 daily/energy/offline 三键',
    typeof CONFIG.subscribeTemplates === 'object' &&
    'daily' in CONFIG.subscribeTemplates && 'energy' in CONFIG.subscribeTemplates && 'offline' in CONFIG.subscribeTemplates);
  ok('config 注释标明需 MP 后台申请模板', cfgSrc.indexOf('订阅消息') >= 0 && cfgSrc.indexOf('requestSubscribeMessage') >= 0);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
