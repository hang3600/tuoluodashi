// 设计令牌（UI 一致性收口 · ①）—— 字体/色彩/圆角/手感 唯一来源
// 原则：令牌默认值与现状完全一致（改名不改观感），供 render/spintop 收敛使用；长尾逐批迁移。
const UI = {
  family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif',   // 原 APPLE_FONT
  // 字号台阶：digit(大数字) / h1(面板标题) / h2(板块) / title(按钮/副标) / head(粗标签) / body / label / small / tiny
  font: { digit: 46, h1: 26, h2: 20, title: 17, head: 16, body: 14, label: 13, small: 12, tiny: 11 },
  color: {
    primary:   '#7e57c2',                  // 主紫
    accent:    '#e53935',                  // 主红
    success:   '#00e676',                  // 成功/能量绿
    warn:      '#ff7043',                  // 警告/必杀橙
    gold:      '#ffd54f',                  // 金色（全图鉴/大奖/翻倍）
    goldBright:'#ffca28',                  // 亮金
    text:      '#ffffff',
    textWeak:  'rgba(255,255,255,0.72)',
    disabled:  'rgba(255,255,255,0.32)',
    mask:      'rgba(35,18,70,0.62)'       // 面板遮罩
  },
  radius: { sm: 8, md: 14, lg: 20 },
  motion: { pressScale: 0.94, pressDur: 0.18, panelDur: 0.26, panelOvershoot: 1.03, floatRise: 26, floatLife: 1.0, hapticWin: 'medium', hapticIn: 'light', introDur: 0.8 }
};

module.exports = { UI, APPLE_FONT: UI.family };