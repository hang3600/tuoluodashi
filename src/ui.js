// 设计令牌（UI 一致性收口 · ①/②/③）—— 字体/色彩/圆角/手感/图标/开始动画 唯一来源
const UI = {
  family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif',
  font: { digit: 46, h1: 26, h2: 20, title: 17, head: 16, body: 14, label: 13, small: 12, tiny: 11 },
  color: {
    primary: '#7e57c2', accent: '#e53935', success: '#00e676', warn: '#ff7043',
    gold: '#ffd54f', goldBright: '#ffca28', text: '#ffffff',
    textWeak: 'rgba(255,255,255,0.72)', disabled: 'rgba(255,255,255,0.32)',
    mask: 'rgba(35,18,70,0.62)'
  },
  radius: { sm: 8, md: 14, lg: 20 },
  icon: { glyph: '#ffffff', stroke: 'rgba(255,255,255,0.30)', weight: 1.4 },   // ③3-3 单色图形 + 统一描边
  motion: { pressScale: 0.94, pressDur: 0.18, panelDur: 0.26, panelOvershoot: 1.03, floatRise: 26, floatLife: 1.0, hapticWin: 'medium', hapticIn: 'light', introDur: 0.8 }
};

module.exports = { UI, APPLE_FONT: UI.family };