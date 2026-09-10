#!/usr/bin/env node
'use strict';
// ============================================================
// 抽卡广告位回归测试（2026-09-06 二次修正）
// 背景：4 个抽卡广告位为「激励视频」类型；用户要求**不要**「看广告免费再抽」按钮，
//       而是恢复「隐藏自动弹」行为——抽卡结果卡收掉时，第3/6/9抽（及循环/逢2随机）
//       直接自动弹出对应激励视频（无按钮、无选择、玩家无感，等同原隐藏插屏）。
// 本套件锁定：
//   1) config 4 个新激励位 ID 就位、旧 interstitial 键名已移除
//   2) main.js 不再走 Interstitial；_dismissDrawCard 收卡时自动 Rewarded.show（无 _onDrawAdReward 按钮逻辑）
//   3) 抽卡结果卡**不**渲染 draw_ad_reward 按钮；输入分支**不**处理该动作
//   4) game 调度逻辑（shouldScheduleDrawInterstitial）仍按抽数返回 key（向后兼容 smoke_interstitial_multi）
//   5) 看完计当日上限（markDrawInterstitialShown）
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

const { CONFIG } = require(path.join(SRC, 'config.js'));
const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const renderSrc = fs.readFileSync(path.join(SRC, 'render.js'), 'utf8');
const gameSrc = fs.readFileSync(path.join(SRC, 'game.js'), 'utf8');

console.log('\n【1】config：4 个新激励位 ID 就位，旧 interstitial 键名已移除');
{
  const expect = {
    drawAdUnitId3: 'adunit-4729d5af4e1dabc8',
    drawAdUnitId6: 'adunit-f02da65fdd7f378f',
    drawAdUnitId9: 'adunit-b87930618c41419e',
    drawAdUnitIdRand: 'adunit-af96563df3ed4e15'
  };
  for (const k of Object.keys(expect)) {
    ok('config.' + k + ' = ' + expect[k], CONFIG[k] === expect[k], CONFIG[k]);
  }
  ok('旧 interstitialAdUnitId* 键名已全部移除', !('interstitialAdUnitId3' in CONFIG) && !('interstitialAdUnitId6' in CONFIG) && !('interstitialAdUnitId9' in CONFIG) && !('interstitialAdUnitIdRand' in CONFIG));
  const oldIds = ['6543c4bf1cb6c43f', 'dd44cd0a69b8b491', '8feabb5cdeeb1a0c', '9023954e4d6ef71f'];
  const anyOld = oldIds.some(id => JSON.stringify(CONFIG).indexOf(id) >= 0);
  ok('旧 4 个插屏 ID 已不再出现于 config', !anyOld);
}

console.log('\n【2】main.js：收卡自动弹激励视频（无按钮 / 无 _onDrawAdReward）');
{
  ok('已移除 Interstitial.init 抽卡位调用', mainSrc.indexOf("Interstitial.init({ draw3:") < 0);
  ok('_onDrawAdReward 方法已彻底移除（不再有按钮逻辑）', mainSrc.indexOf('_onDrawAdReward') < 0);
  ok('_dismissDrawCard 内调用 Rewarded.show（收卡自动弹）', /_dismissDrawCard\(\)[\s\S]*?Rewarded\.show\(/.test(mainSrc));
  ok('unitMap 引用 4 个 drawAdUnitId*', mainSrc.indexOf('CONFIG.drawAdUnitId3') >= 0 && mainSrc.indexOf('CONFIG.drawAdUnitId6') >= 0 && mainSrc.indexOf('CONFIG.drawAdUnitId9') >= 0 && mainSrc.indexOf('CONFIG.drawAdUnitIdRand') >= 0);
  ok('收卡时消费广告位（置空 _drawRewardKey）', mainSrc.indexOf('this.game._drawRewardKey = null') >= 0);
  ok('无遗留 Interstitial.show / _drawAdPending', mainSrc.indexOf('Interstitial.show(') < 0 && mainSrc.indexOf('this._drawAdPending') < 0 && mainSrc.indexOf('this._drawAdPendingKey') < 0);
}

console.log('\n【3】输入分支 + render：绝无「看广告免费再抽」按钮');
{
  ok('抽卡结果卡输入分支不处理 draw_ad_reward', mainSrc.indexOf("'draw_ad_reward'") < 0);
  ok('render 不注册 draw_ad_reward 按钮', renderSrc.indexOf("action: 'draw_ad_reward'") < 0);
  ok('render 不画「看广告免费再抽」按钮文案', renderSrc.indexOf("'看广告免费再抽'") < 0);
  ok('render 仅在「收入背包」按钮（无广告按钮分支）', renderSrc.indexOf("'收入背包'") >= 0);
}

console.log('\n【4】game：抽卡广告调度逻辑保持不变（向后兼容 smoke_interstitial_multi）');
{
  ok('shouldScheduleDrawInterstitial 仍存在', gameSrc.indexOf('shouldScheduleDrawInterstitial()') >= 0);
  ok('markDrawInterstitialShown 仍存在（计每日上限）', gameSrc.indexOf('markDrawInterstitialShown()') >= 0);

  const { GameState } = require(path.join(SRC, 'game.js'));
  const g = new GameState();
  g.drawsSinceAd = 3;  ok('抽数3 → draw3', g.shouldScheduleDrawInterstitial() === 'draw3');
  g.drawsSinceAd = 6;  ok('抽数6 → draw6', g.shouldScheduleDrawInterstitial() === 'draw6');
  g.drawsSinceAd = 9;  ok('抽数9 → draw9', g.shouldScheduleDrawInterstitial() === 'draw9');
  g.drawsSinceAd = 1;  ok('抽数1 → null（不弹）', g.shouldScheduleDrawInterstitial() === null);
}

console.log('\n【5】调度落地到自动弹（_maybeScheduleDrawAd → _dismissDrawCard → Rewarded.show）');
{
  ok('_maybeScheduleDrawAd 把 key 记到 _drawRewardKey', mainSrc.indexOf('this.game._drawRewardKey = key') >= 0);
  ok('_dismissDrawCard 读取 _drawRewardKey 并弹出', /const adKey = this\.game\._drawRewardKey[\s\S]*?Rewarded\.show\(/.test(mainSrc));
}

console.log('\n════════════════════════════');
console.log((fail === 0 ? '✅' : '❌') + ' smoke_draw_reward：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
