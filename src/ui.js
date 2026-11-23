// 设计令牌（UI 一致性收口 · ①/②/③）—— 字体/色彩/圆角/手感/图标/开始动画 唯一来源
const UI = {
  family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif',
  // 数字嗓音（花叔范式「字体就是声音」· 2026-11-22）：Rajdhani-Bold 数字子集经 loadFontFace 注册为
  // 'GameDigits'（src/fontdigits.js，1.6KB woff2）；仅用于纯数字展示（金币/分数/连胜/倒计时），
  // 中英混排文字不用它（子集无汉字字形，依赖回退会因实现差异出现 tofu）
  familyDigit: '"GameDigits", -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
  font: { digit: 46, h1: 26, h2: 20, title: 17, head: 16, body: 14, label: 13, small: 12, tiny: 11 },
  color: {
    // 语义色词典（花叔范式 04 一套语义色 · 2026-11-22）：每种颜色只回答一个问题——
    //   gold/goldBright = 货币与荣耀（金币/奖励/达成时刻）  success = 正向反馈（对勾/确认）
    //   primary = 品牌紫（主按钮/面板底）  accent = 警示与失败  ink.* = 白色文字层级
    //   装饰用色不属于语义，不得借用以上任何一档做装饰
    primary: '#7e57c2', accent: '#e53935', success: '#00e676', warn: '#ff7043',
    gold: '#ffd54f', goldBright: '#ffca28', text: '#ffffff',
    textWeak: 'rgba(255,255,255,0.72)', disabled: 'rgba(255,255,255,0.32)',
    mask: 'rgba(35,18,70,0.62)',
    // 白色透明度 5 档（设计评审 2026-11-22：20+ 种手写字面量归一；就近档映射 0.4→disabled / 0.6&0.55→body）
    ink: {
      faint: 'rgba(255,255,255,0.06)',   // 底衬/填充（原 0.06/0.07）
      line: 'rgba(255,255,255,0.16)',    // 描边/分隔（原 0.16）
      body: 'rgba(255,255,255,0.55)',    // 次级正文（原 0.55/0.6）
      strong: 'rgba(255,255,255,0.72)',  // 强调文字（= textWeak 同值，语义别名）
      bright: 'rgba(255,255,255,0.85)'   // 近主文字（原 0.85）
    }
  },
  radius: { sm: 8, md: 14, lg: 20 },
  icon: { glyph: '#ffffff', stroke: 'rgba(255,255,255,0.30)', weight: 1.4 },   // ③3-3 单色图形 + 统一描边
  motion: { pressScale: 0.94, pressDur: 0.18, panelDur: 0.26, panelOvershoot: 1.03, floatRise: 26, floatLife: 1.0, hapticWin: 'medium', hapticIn: 'light', introDur: 0.8 }
};

module.exports = { UI, APPLE_FONT: UI.family };