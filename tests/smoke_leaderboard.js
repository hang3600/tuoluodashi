// 冒烟套件 —— P0-2 开放数据域好友排行榜（零后端）
//
// 锁定行为：
//   ① buildKVDataList：arenaPts/highScore/streak/streakWeek 四 key，streak 只在所属周口径内有效；
//   ② 同步节流（SYNC_MIN_MS 内只写一次）+ 无 wx 静默；
//   ③ game.noteBattleScore：历史最高分/当周连胜峰值记录 + 触发云同步（前移时钟越过节流窗）；
//   ④ 假好友榜下线：game.js 与 render.js 中假好友字段/函数零残留（防回退）；
//   ⑤ game.json 声明 openDataContext，opencontext/game.js 存在且 Node 引入安全；
//   ⑥ opencontext 纯函数：buildRows 排序 / 过期周连胜过滤 / 自己合并去重；
//   ⑦ 主域渲染与派发接线（源码级）：三榜页签 + sharedCanvas 上屏 + 兜底空态。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n【1】buildKVDataList（纯函数）');
{
  const ldb = require(path.join(SRC, 'leaderboard.js'));
  const g = { arenaPts: 321, highScore: 2345, streakWeek: ldb.weekKey(), streakWeekMax: 4 };
  const kv = ldb.buildKVDataList(g);
  ok('4 个 key 齐全', kv.length === 4 && kv.map(k => k.key).join(',') === 'arenaPts,highScore,streak,streakWeek');
  ok('积分/高分值正确', kv[0].value === '321' && kv[1].value === '2345');
  ok('本周连胜上报', kv[2].value === '4');
  const g2 = { arenaPts: 0, highScore: 10, streakWeek: ldb.weekKey(new Date(Date.now() - 8 * 86400000)), streakWeekMax: 9 };
  ok('过期周连胜按 0 上报', ldb.buildKVDataList(g2)[2].value === '0');
  ok('空 game 全 0 不崩', ldb.buildKVDataList(null).every(k => k.value === '0' || isWeekKey(k.value)));
}
function isWeekKey(s) { return /^\d{4}-\d{1,2}-\d{1,2}$/.test(s); }

console.log('\n【2】同步节流 + 无 wx 静默');
{
  const ldb = require(path.join(SRC, 'leaderboard.js'));
  const writes = [];
  global.wx = { setUserCloudStorage: (o) => { writes.push(o); } };
  const g = { arenaPts: 1, highScore: 2, streakWeek: ldb.weekKey(), streakWeekMax: 1 };
  ok('首次写入', ldb.syncLeaderboard(g) === true && writes.length === 1);
  ok('节流窗口内不重复写', ldb.syncLeaderboard(g) === false && writes.length === 1);
  ok('force 绕过节流', ldb.syncLeaderboard(g, true) === true && writes.length === 2);
  ok('KVDataList 结构合法', writes[0].KVDataList.every(k => k.key && typeof k.value === 'string'));
  global.wx = undefined;
  ok('无 wx 静默', ldb.syncLeaderboard(g) === false);
}

console.log('\n【3】noteBattleScore：高分/周连胜峰值 + 云同步触发');
{
  // 节流时间戳是 leaderboard 模块级的（【2】已消耗过一次节流窗口）。
  // 这里把 Date.now 前移（每次读 +15s，稳越 10s 节流窗），模拟"下一局"的时间流逝。
  const ldb = require(path.join(SRC, 'leaderboard.js'));
  const gameMod = require(path.join(SRC, 'game.js'));
  const writes = [];
  global.wx = { setUserCloudStorage: (o) => { writes.push(o); } };
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => (fake += 15000);
  const g = new gameMod.GameState();
  g.winStreak = 3;
  g.noteBattleScore(1200);
  ok('历史最高分记录', g.highScore === 1200);
  ok('当周连胜峰值 = winStreak', g.streakWeekMax === 3 && g.streakWeek === ldb.weekKey());
  g.noteBattleScore(1000);
  ok('低分不刷新 highScore', g.highScore === 1200);
  g.winStreak = 5;
  g.noteBattleScore(900);
  ok('连胜峰值取 max', g.streakWeekMax === 5);
  Date.now = realNow;
  ok('云同步被触发（越过节流窗后按局写入）', writes.length >= 2, 'writes=' + writes.length);
  global.wx = undefined;
}

console.log('\n【4】假好友榜下线（防回退）');
{
  const gameSrc = fs.readFileSync(path.join(SRC, 'game.js'), 'utf8');
  const renderSrc = fs.readFileSync(path.join(SRC, 'render.js'), 'utf8');
  ok('game.js 无旧假好友字段残留', gameSrc.indexOf('friendList') < 0 && gameSrc.indexOf('friendHigh') < 0);
  ok('render.js 无旧假好友函数引用', renderSrc.indexOf('friendList') < 0);
  const gameMod = require(path.join(SRC, 'game.js'));
  ok('GameState 原型上无假好友函数', typeof gameMod.GameState.prototype.friendList !== 'function');
}

console.log('\n【5】开放数据域接线（game.json + opencontext）');
{
  const gj = JSON.parse(fs.readFileSync(path.join(ROOT, 'game.json'), 'utf8'));
  ok('game.json 声明 openDataContext', gj.openDataContext === 'opencontext');
  const ocFile = path.join(ROOT, 'opencontext', 'index.js');
  ok('opencontext/index.js 存在（基础库按 <openDataContext>/index.js 找入口）', fs.existsSync(ocFile));
  const oc = require(path.join(ROOT, 'opencontext', 'index.js'));
  ok('opencontext 页签常量', JSON.stringify(oc.BOARDS) === JSON.stringify('arena,high,streak'.split(',')));
  ok('opencontext 导出纯函数', typeof oc.buildRows === 'function' && typeof oc.weekKeyOf === 'function');
}

console.log('\n【6】opencontext.buildRows：排序 / 过期周过滤 / 自己合并去重');
{
  const ldb = require(path.join(SRC, 'leaderboard.js'));
  const oc = require(path.join(ROOT, 'opencontext', 'index.js'));
  const wk = ldb.weekKey();
  const oldWk = ldb.weekKey(new Date(Date.now() - 8 * 86400000));
  const friends = [
    { nickname: '阿柴', avatarUrl: 'http://a/1', KVDataList: [{ key: 'arenaPts', value: '500' }] },
    { nickname: '豆豆', avatarUrl: 'http://a/2', KVDataList: [{ key: 'streak', value: '7' }, { key: 'streakWeek', value: wk }] },
    { nickname: '老王', avatarUrl: 'http://a/3', KVDataList: [{ key: 'streak', value: '9' }, { key: 'streakWeek', value: oldWk }] }
  ];
  const self = { nickname: '自己', avatarUrl: 'http://a/me', KVDataList: [{ key: 'highScore', value: '999' }] };
  const rowsA = oc.buildRows(friends, self, 'arena', wk);
  ok('段位榜排序', rowsA.length === 4 && rowsA[0].name === '阿柴' && rowsA[0].value === 500, JSON.stringify(rowsA));
  const rowsS = oc.buildRows(friends, self, 'streak', wk);
  ok('过期周连胜归 0', rowsS.find(r => r.name === '老王').value === 0);
  const rowsSelf = oc.buildRows(
    [{ nickname: '自己', avatarUrl: 'http://a/me', KVDataList: [{ key: 'highScore', value: '100' }] }],
    self,
    'high', wk);
  ok('自己与好友重复 → 合并取高分且标记 self', rowsSelf.length === 1 && rowsSelf[0].value === 999 && rowsSelf[0].self === true);
}

console.log('\n【7】主域渲染与派发接线（源码级）');
{
  const renderSrc = fs.readFileSync(path.join(SRC, 'render.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  ok('三榜页签动作注册', /action: 'ldb_arena'/.test(renderSrc) && /action: 'ldb_high'/.test(renderSrc) && /action: 'ldb_streak'/.test(renderSrc));
  ok('sharedCanvas 上屏 drawImage', /drawImage\(odc\.canvas/.test(renderSrc));
  ok('打开面板强制重发榜单消息', /_ldbMsgKey = null/.test(renderSrc));
  ok('无开放数据域环境有空态兜底', /好友榜单加载中/.test(renderSrc));
  ok('main 分发三榜页签 + 分享 + 洗词条', /ldb_arena/.test(mainSrc) && /ldb_share/.test(mainSrc) && /trait_reroll/.test(mainSrc));
  ok('main._shareLeaderboard 带真实战绩钩子', /_shareLeaderboard\(\)\s*\{[\s\S]{0,200}streakWeekMax/.test(mainSrc));
}

console.log('\n────────────────────────');
console.log('P0-2 结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
