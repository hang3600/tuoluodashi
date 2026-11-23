// 数字展示字体（2026-11-22 · 花叔范式「字体就是声音」）
// Rajdhani-Bold 数字子集（0-9 + % + . , + × : !），woff2 仅 1.6KB —— 由 scripts/build-fontdigits.js 生成，勿手改
// 授权：SIL Open Font License 1.1（Indian Type Foundry），全文见 src/OFL-Rajdhani.txt
// 用法：main 启动时 loadDigitFont()（LOW 档跳过）；ctx.font 用 UI.familyDigit（含系统回退）
const B64 = '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';

let _loaded = false;
function loadDigitFont() {
  if (_loaded) return false;
  _loaded = true;
  try {
    if (typeof wx === 'undefined' || !wx.loadFontFace) {
      _loaded = false;   // 无 wx 环境不锁死，允许重试
      return false;
    }
    wx.loadFontFace({
      global: true,
      family: 'GameDigits',
      source: 'url("data:font/woff2;base64,' + B64 + '")',
      success: function () {},
      fail: function () {}
    });
    return true;
  } catch (e) { return false; }
}

module.exports = { loadDigitFont, DIGIT_FAMILY: 'GameDigits' };
