// 冒烟套件 —— 回归礼包延后弹（选项 A）：首次有意义交互即弹 + returnGraceMs 兜底 + 整局一次守卫
// 路径相对化：无论从哪个目录调用，都基于本文件位置定位 src/
process.env.TZ = 'Asia/Shanghai';

const path = require('path');
const fs = require('fs');
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const mainSrc = fs.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8');
const gameSrc = fs.readFileSync(path.join(SRC_DIR, 'game.js'), 'utf8');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { CONFIG } = require(path.join(SRC_DIR, 'config.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n【1】启动段：不再同步/首屏直接调用回归判定（首屏零阻挡）');
{
  // this.game.checkReturn() 在 main.js 全文只允许出现一次，且必须位于 _maybePromptReturn 方法体内
  const directCalls = mainSrc.split('this.game.checkReturn()').length - 1;
  ok('this.game.checkReturn() 全文仅 1 次调用（收敛到 _maybePromptReturn 内）', directCalls === 1, '实际 ' + directCalls + ' 次');
  const m = mainSrc.match(/_maybePromptReturn\(\)\s*\{[\s\S]*?\n  \}/);
  ok('_maybePromptReturn 方法体内包含 checkReturn 调用', !!m && m[0].indexOf('this.game.checkReturn()') >= 0);
  ok('启动段无旧版 1s 硬编码兜底（_bootStartTime) >= 1000 已移除）', mainSrc.indexOf('_bootStartTime) >= 1000') < 0);
  ok('启动段仍设置 _pendingReturnInit = true（延后触发标记）', mainSrc.indexOf('this._pendingReturnInit = true') >= 0);
  ok('启动段仍记录 _bootStartTime（兜底计时基准）', mainSrc.indexOf('this._bootStartTime = Date.now()') >= 0);
}

console.log('\n【2】首次有意义交互即弹（onTap 命中后触发）');
{
  ok('onTap 命中有效元素后调用 _maybePromptReturn', mainSrc.indexOf("this._maybePromptReturn(); // 首次有意义交互即检测回归礼包") >= 0);
  ok('调用点位于 hitTest 空判定之后（空白点击不触发）', (() => {
    const iHit = mainSrc.indexOf('if (!hit) return;');
    const iCall = mainSrc.indexOf('this._maybePromptReturn(); // 首次');
    return iHit >= 0 && iCall > iHit;
  })());
}

console.log('\n【3】整局一次守卫 + loop 兜底计时');
{
  ok('_maybePromptReturn 内有 _pendingReturnInit 单次守卫', (() => {
    const m = mainSrc.match(/_maybePromptReturn\(\)\s*\{[\s\S]*?\n  \}/);
    return !!m && m[0].indexOf('if (!this._pendingReturnInit) return;') >= 0 && m[0].indexOf('this._pendingReturnInit = false;') >= 0;
  })());
  ok('loop 兜底使用 CONFIG.returnGraceMs（config 驱动，默认 8000）', mainSrc.indexOf('CONFIG.returnGraceMs || 8000') >= 0);
  ok('loop 兜底同样收敛到 _maybePromptReturn（不直接调 checkReturn）', (() => {
    const m = mainSrc.match(/_pendingReturnInit && \(now - this\._bootStartTime\)[\s\S]{0,120}/);
    return !!m && m[0].indexOf('this._maybePromptReturn();') >= 0;
  })());
}

console.log('\n【4】功能未被误删（game.js 侧运行时验证）');
{
  ok('GameState 原型仍导出 checkReturn（离线判定能力）', typeof GameState.prototype.checkReturn === 'function');
  ok('GameState 原型仍导出 claimReturn（领奖能力）', typeof GameState.prototype.claimReturn === 'function');
  ok('game.js 保留 offlineOpen 面板开关（弹窗渲染依赖）', gameSrc.indexOf('offlineOpen') >= 0);
}

console.log('\n【5】config 驱动（兜底时长可配置）');
{
  ok('CONFIG.returnGraceMs = 8000', CONFIG.returnGraceMs === 8000, '实际 ' + CONFIG.returnGraceMs);
  ok('config.js 含 returnGraceMs 字段与注释说明', gameSrc.indexOf('returnGraceMs') >= 0 || fs.readFileSync(path.join(SRC_DIR, 'config.js'), 'utf8').indexOf('returnGraceMs') >= 0);
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
