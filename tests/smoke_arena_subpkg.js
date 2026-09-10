/**
 * arena 背景分包回归：确认 prepSrc 在真机分支把 'arena' 映射到 battle 分包内路径，
 * 且 tops/home 等其他 folder 行为不变（避免误伤首包资源路径）。
 *
 * 背景：images/arena(192KB) 仅 battle/spintop.js 使用，已整包搬进 battle 分包
 * （battle/images/arena/arena_neon_bg.jpg），故 prepSrc 对 folder==='arena' 返回
 * battle 分包内路径；主包资源（tops/home/icons/codex）路径保持不变。
 *
 * 核心断言：
 *   1. prepSrc(null,'arena_neon_bg.jpg','arena') === 'battle/images/arena/arena_neon_bg.jpg'
 *   2. prepSrc(null,'wood-lv1.png','tops')        === 'images/tops/wood-lv1.png'（回归）
 *   3. prepSrc(null,'home_cosmic.jpg','home')     === 'images/home/home_cosmic.jpg'（回归）
 */
const path = require('path');
const { prepSrc } = require(path.join(__dirname, '..', 'src', 'utils.js'));

let pass = 0, fail = 0;
function ok(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + desc + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + desc + (extra ? ' — ' + extra : '')); }
}

// 无 wx 环境 → prepSrc 走真机分支（isDevtools=false），即包内文件路径
const arena = prepSrc(null, 'arena_neon_bg.jpg', 'arena');
ok("arena 走 battle 分包内路径", arena === 'battle/images/arena/arena_neon_bg.jpg', arena);

const tops = prepSrc(null, 'wood-lv1.png', 'tops');
ok("tops 仍在主包 images/tops", tops === 'images/tops/wood-lv1.png', tops);

const home = prepSrc(null, 'home_cosmic.jpg', 'home');
ok("home 仍在主包 images/home", home === 'images/home/home_cosmic.jpg', home);

console.log('\n' + (fail ? '❌' : '✅') + ' arena 分包路径断言：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
