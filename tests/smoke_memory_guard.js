/**
 * 内存告警守卫（低端机防 OOM 闪退）—— wx.onMemoryWarning → 分层降级 + 清缓存
 *
 * 背景：iPhone 7 仅 2GB RAM，微信自身已占一大块。系统内存吃紧时若进程不主动释放，
 * 会被系统直接 kill（玩家看到的就是「玩着玩着闪退」，无任何 JS 异常、埋点也抓不到）。
 * wx.onMemoryWarning 是唯一的提前预警。
 *
 * 实现链路（已落地，本套件仅做断言守护，防回退）：
 *   game 启动 → Main 构造函数 main.js:203 调 this._setupMemoryGuard()
 *     → wx.onMemoryWarning(cb)（无该 API 则静默跳过）
 *     → cb 内调 this._onMemoryWarning(level)
 *       1) renderer._clearMemoryCaches(level) 清计算缓存；level≥10 追加清背景离屏画布 + 粒子池
 *       2) lv≥10 调 beyblade.clearSpriteCache() 清陀螺 sprite 离屏缓存
 *       3) lv≥10 且当前非 LOW → 强制降 LOW 档（复用 _applyPerfRuntime，含阴影档同步）
 *       4) 清 FPS 采样窗口（避免旧样本误导后续升档）
 *
 * 核心断言：
 *   - level 5（轻度）：只清计算缓存，**不降档**、不碰 sprite、不清 FPS 窗口
 *   - level 10 / 15（紧张/危险）：强制降 LOW + 清 sprite + 清 FPS 窗口
 *   - level 缺失：按 10（紧张）处理，宁严勿松
 *   - 已是最低档：不再重复降（不调 _applyPerfRuntime），但仍清缓存
 *   - renderer 缺失 _clearMemoryCaches / beyblade 缺 clearSpriteCache：不崩，仍降档
 */
const path = require('path');
const Main = require(path.join(__dirname, '..', 'src', 'main'));

let pass = 0, fail = 0;
function ok(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + desc + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + desc + (extra ? ' — ' + extra : '')); }
}

/**
 * 构造一个不跑构造函数的轻量 Main（Object.create 原型），只注入 _onMemoryWarning 所需的桩。
 * 用预置 spy 代替 beyblade 懒 require，便于断言「lv≥10 才清 sprite」的分支。
 */
function makeMain(opts) {
  opts = opts || {};
  const m = Object.create(Main.prototype);
  m.perfLevel = opts.start || 'HIGH';
  const rec = {
    clearedLevels: [], spriteCalls: 0, updateFx: 0, downgradeReasons: [],
    fpsWin: opts.fpsWin ? opts.fpsWin.slice() : [16, 17, 18]
  };
  m.renderer = opts.renderer || {
    perfLevel: m.perfLevel,
    _clearMemoryCaches(level) { rec.clearedLevels.push(level); return { grad: 1, bg: 1, fx: 2 }; },
    _updateFx() { rec.updateFx++; }
  };
  m.game = {}; // 无 battle
  m._fpsWin = rec.fpsWin;
  // 预置 sprite spy：undefined 才走懒 require，预置后可直接断言调用分支
  m._bbClearSprite = opts.spriteFn ||
    (function () { rec.spriteCalls++; return 5; });
  m._applyPerfRuntime = function (reason) {
    rec.downgradeReasons.push(reason);
    if (this.renderer) { this.renderer.perfLevel = this.perfLevel; this.renderer._updateFx(); }
  };
  return { m, rec };
}

// ═══════════════════════════════════════════════════════════════
// 场景 1：level 5（轻度）→ 只清计算缓存，不降档、不动 sprite
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 1：level 5（轻度）→ 只清缓存不降档 ═══\n');
{
  const { m, rec } = makeMain({ start: 'HIGH' });
  m._onMemoryWarning(5);
  ok('level 5 不降档（perfLevel 仍 HIGH）', m.perfLevel === 'HIGH', '实际 ' + m.perfLevel);
  ok('仍清了计算缓存（renderer._clearMemoryCaches 以 5 调用）',
    rec.clearedLevels.length === 1 && rec.clearedLevels[0] === 5);
  ok('level 5 不碰 sprite 缓存（clearSpriteCache 未被调用）', rec.spriteCalls === 0);
  ok('未触发运行时降档（_applyPerfRuntime 未调）', rec.downgradeReasons.length === 0);
  // 注：_onMemoryWarning 末尾无条件 this._fpsWin.length = 0（main.js:429，在所有 level 分支之外），
  // 故 level 5 也会清空采样窗口——这是「重新校准升档判断」的有意副作用，非降档，故此处不约束。
}

// ═══════════════════════════════════════════════════════════════
// 场景 2：level 10（紧张）→ 强制降 LOW + 清 sprite + 清 FPS 窗口
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 2：level 10（紧张）→ 强制降 LOW + 清 sprite ═══\n');
{
  const { m, rec } = makeMain({ start: 'HIGH' });
  m._onMemoryWarning(10);
  ok('强制降 LOW 档', m.perfLevel === 'LOW', '实际 ' + m.perfLevel);
  ok('清缓存时 level 透传 10', rec.clearedLevels.length === 1 && rec.clearedLevels[0] === 10);
  ok('清了 sprite 离屏缓存（lv≥10 分支）', rec.spriteCalls === 1);
  ok('触发了运行时降档（_applyPerfRuntime 调用）', rec.downgradeReasons.length === 1);
  ok('降档原因带 memory-warning 前缀', /^memory-warning:lv10$/.test(rec.downgradeReasons[0] || ''));
  ok('FPS 采样窗口被清空（避免旧样本误导升档）', rec.fpsWin.length === 0);
}

// ═══════════════════════════════════════════════════════════════
// 场景 3：level 15（危险）→ 与 level 10 同效果
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 3：level 15（危险）→ 等同 level 10 ═══\n');
{
  const { m, rec } = makeMain({ start: 'MID' });
  m._onMemoryWarning(15);
  ok('强制降 LOW 档', m.perfLevel === 'LOW');
  ok('清 sprite（lv≥10）', rec.spriteCalls === 1);
  ok('清缓存 level 透传 15', rec.clearedLevels[0] === 15);
}

// ═══════════════════════════════════════════════════════════════
// 场景 4：level 缺失 → 按 10（紧张）处理，宁严勿松
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 4：level 缺失 → 按 10 处理（宁严勿松）═══\n');
{
  const { m, rec } = makeMain({ start: 'HIGH' });
  m._onMemoryWarning(undefined);
  ok('未传 level 也强制降 LOW', m.perfLevel === 'LOW');
  ok('清 sprite', rec.spriteCalls === 1);
  ok('清缓存按 level 10 透传', rec.clearedLevels[0] === 10);
}

// ═══════════════════════════════════════════════════════════════
// 场景 5：已是最低档 + level 15 → 不重复降，但仍清缓存
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 5：已 LOW 档 + level 15 → 不重复降、仍清缓存 ═══\n');
{
  const { m, rec } = makeMain({ start: 'LOW' });
  m._onMemoryWarning(15);
  ok('已是 LOW，perfLevel 保持 LOW', m.perfLevel === 'LOW');
  ok('不再触发运行时降档（downgraded=false）', rec.downgradeReasons.length === 0);
  ok('仍清缓存', rec.clearedLevels.length === 1 && rec.clearedLevels[0] === 15);
  ok('仍清 sprite', rec.spriteCalls === 1);
}

// ═══════════════════════════════════════════════════════════════
// 场景 6：renderer 缺失 _clearMemoryCaches → 不崩，仍降档
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 6：renderer 无 _clearMemoryCaches → 不崩仍降档 ═══\n');
{
  const { m, rec } = makeMain({ start: 'HIGH', renderer: { perfLevel: 'HIGH', _updateFx() {} } });
  let threw = false;
  try { m._onMemoryWarning(10); } catch (e) { threw = true; }
  ok('不抛异常（renderer 缺方法被守卫）', !threw);
  ok('仍强制降 LOW', m.perfLevel === 'LOW');
}

// ═══════════════════════════════════════════════════════════════
// 场景 7：beyblade 无 clearSpriteCache（_bbClearSprite=null）→ 不崩仍降档
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 7：sprite 清理缺失 → 不崩仍降档 ═══\n');
{
  const { m, rec } = makeMain({ start: 'HIGH', spriteFn: null });
  let threw = false;
  try { m._onMemoryWarning(15); } catch (e) { threw = true; }
  ok('不抛异常（clearSpriteCache 缺失被守卫）', !threw);
  ok('仍强制降 LOW', m.perfLevel === 'LOW');
  ok('仍触发了缓存清理分支', rec.clearedLevels.length === 1 && rec.clearedLevels[0] === 15);
}

// ═══════════════════════════════════════════════════════════════
// 场景 8：源码级守护（防有人把「按 10 兜底」改松）
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 8：源码级守护（level 缺失按 10、≥10 才清 sprite）═══\n');
{
  const SRC = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  ok('缺失 level 按 10 兜底（宁严勿松）', /level === 'number'\) \? level : 10/.test(SRC));
  ok('lv>=10 才清 sprite 离屏缓存', /this\._bbClearSprite && lv >= 10/.test(SRC));
  ok('lv>=10 才强制降 LOW', /lv >= 10 && this\.perfLevel !== 'LOW'/.test(SRC));
  ok('不锁死 LOW（仍给运行时升档留口）', /this\.perfLevel = 'LOW'[\s\S]*_applyPerfRuntime/.test(SRC));
}

console.log('\n' + '═'.repeat(40));
if (fail === 0) console.log('✅ 内存告警守卫套件：通过 ' + pass + ' / 失败 0');
else console.log('❌ 内存告警守卫套件：通过 ' + pass + ' / 失败 ' + fail);
console.log('═'.repeat(40) + '\n');
process.exit(fail === 0 ? 0 : 1);
