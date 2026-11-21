// UI/UX 视觉审计截图脚本：cli auto 启动开发者工具 → automator 驱动真实画面 → 逐屏截图
// 产物：preview/shots/*.png （供 UI/UX 审计）
const path = require('path');
const automator = require('miniprogram-automator');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SHOT_DIR = path.join(__dirname, '..', 'preview', 'shots');
require('fs').mkdirSync(SHOT_DIR, { recursive: true });

(async () => {
  console.log('[shots] connecting to devtools automation...');
  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  console.log('[shots] connected');
  const shot = async (name) => {
    try {
      await miniProgram.screenshot({ path: path.join(SHOT_DIR, name + '.png') });
      console.log('[shots] ✓ ' + name);
    } catch (e) { console.log('[shots] ✗ ' + name + ': ' + e.message); }
  };
  const ev = (code) => miniProgram.evaluate(code);

  try {
    // 等 SDK 编译 + 游戏启动（首次较慢）
    for (let i = 0; i < 10; i++) {
      try { await miniProgram.systemInfo(); break; } catch (e) { await sleep(3000); }
    }
    console.log('[shots] simulator responsive');
    await sleep(6000);
    await shot('01-home');

    // 图鉴视图
    await ev(() => { const m = GameGlobal.__game; m.game.view = 'codex'; });
    await sleep(800); await shot('02-codex');
    await ev(() => { GameGlobal.__game.game.view = 'home'; });

    // 抽卡仪式
    await ev(() => { const m = GameGlobal.__game; const g = m.game; if (g.inventory.length) g.drawCard = { bb: g.inventory[0], t: 0.3 }; });
    await sleep(600); await shot('03-drawcard');
    await ev(() => { GameGlobal.__game.game.drawCard = null; });

    // 签到面板
    await ev(() => { GameGlobal.__game.game.signOpen = true; });
    await sleep(600); await shot('04-sign');
    await ev(() => { GameGlobal.__game.game.signOpen = false; });

    // 福利中心
    await ev(() => { GameGlobal.__game.game.welfareOpen = true; });
    await sleep(600); await shot('05-welfare');
    await ev(() => { GameGlobal.__game.game.welfareOpen = false; });

    // 周末商店
    await ev(() => { GameGlobal.__game.game.weekShopOpen = true; });
    await sleep(600); await shot('06-weekshop');
    await ev(() => { GameGlobal.__game.game.weekShopOpen = false; });

    // 竞技场
    await ev(() => { GameGlobal.__game.game.arenaOpen = true; });
    await sleep(600); await shot('07-arena');
    await ev(() => { GameGlobal.__game.game.arenaOpen = false; });

    // 战斗：直接 _startBattle（stage 1）
    await ev(() => {
      const m = GameGlobal.__game;
      const g = m.game;
      const bb = g.platformSlots[0] || g.inventory[0];
      if (bb) m._startBattle(bb, null, { active: true, stage: 1, buffs: null });
    });
    await sleep(7000); await shot('08-battle-mid');

    // 强制结算 → 结果屏
    await ev(() => { const m = GameGlobal.__game; if (m.game.battle && m.game.battle._settle) m.game.battle._settle(true); });
    await sleep(2500); await shot('09-result');

    // 返回首页
    await ev(() => { const m = GameGlobal.__game; if (m.game.battle) { m.game.battle.end(); } m.game.mode = 'main'; });
    await sleep(1200); await shot('10-home-back');
  } catch (e) {
    console.log('[shots] flow error: ' + e.message);
    try { await shot('99-error'); } catch (e2) {}
  }

  await miniProgram.close();
  console.log('[shots] done');
  process.exit(0);
})().catch(e => { console.error('[shots] launch failed: ' + e.message); process.exit(1); });
