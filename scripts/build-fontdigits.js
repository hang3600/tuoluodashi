// 生成 src/fontdigits.js（数字展示字体 base64 内联）
// 用法：node scripts/build-fontdigits.js
// 输入：fonts/digits.woff2（1.6KB，Rajdhani-Bold 数字子集）
// 子集重建（从 fonts/Rajdhani-Bold.ttf，需 pip install fonttools brotli）：
//   python3 -m fontTools.subset fonts/Rajdhani-Bold.ttf \
//     --unicodes="U+0030-0039,U+002B,U+0025,U+002E,U+002C,U+00D7,U+003A,U+0021,U+0073,U+0047,U+004F" \
//     --flavor=woff2 --output-file=fonts/digits.woff2 --layout-features='' --no-hinting
// 授权：Rajdhani SIL OFL 1.1（Indian Type Foundry），全文见 src/OFL-Rajdhani.txt
const fs = require('fs');
const path = require('path');

const woff = fs.readFileSync(path.join(__dirname, '..', 'fonts', 'digits.woff2'));
const b64 = woff.toString('base64');

const out = `// 数字展示字体（2026-11-22 · 花叔范式「字体就是声音」）
// Rajdhani-Bold 数字子集（0-9 + % + . , + × : !），woff2 仅 1.6KB —— 由 scripts/build-fontdigits.js 生成，勿手改
// 授权：SIL Open Font License 1.1（Indian Type Foundry），全文见 src/OFL-Rajdhani.txt
// 用法：main 启动时 loadDigitFont()（LOW 档跳过）；ctx.font 用 UI.familyDigit（含系统回退）
const B64 = '${b64}';

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
`;

fs.writeFileSync(path.join(__dirname, '..', 'src', 'fontdigits.js'), out);
console.log('✓ src/fontdigits.js 生成完成：', fs.statSync(path.join(__dirname, '..', 'src', 'fontdigits.js')).size, 'bytes');
