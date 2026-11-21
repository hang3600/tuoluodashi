/**
 * 开放数据域 · 好友排行榜渲染（P0-2 · 2026-10-31，零后端）
 * ==========================================================================
 * 本文件运行在微信「开放数据域」隔离环境。入口必须是 index.js —— 基础库按
 * <openDataContext>/index.js 查找入口，命名 game.js 会报「未找到 opencontext/index.js」。
 *   - 只能使用 storage 类 API（getFriendCloudStorage / getUserCloudStorage）与 sharedCanvas；
 *   - 与主域唯一的通信通道：wx.onMessage（主域 postMessage 过来）；
 *   - 触摸事件不会传进来 —— 榜单页签切换由主域处理后再 postMessage 通知本域。
 *
 * 主域（render.js drawBoostPanel）流程：
 *   打开面板 → postMessage({type:'board', w, h}) → 本域拉取好友数据并渲染
 *   → 主域每帧 drawImage(sharedCanvas) 上屏。
 *
 * 三榜（与主域 game.ldbBoard 对应）：
 *   arena  → KV['arenaPts']   本周竞技积分
 *   high   → KV['highScore']  历史最高单局分
 *   streak → KV['streak']     当周连胜峰值（KV['streakWeek'] ≠ 本周 → 视为 0）
 *
 * KV 写入方：src/leaderboard.js（主域 wx.setUserCloudStorage），key/周 key 公式与主域严格一致。
 *
 * 纪律：全部 try/catch 包裹，任何失败 → 空状态文案，绝不抛错（开放数据域抛错无日志可查）。
 * Node 无头环境（typeof wx === 'undefined'）只导出纯函数供冒烟测试，不执行任何初始化。
 */

// ── 纯函数（可单测）：把云存储 records 折算成 {name, avatarUrl, value} 列表并排序 ──
function weekKeyOf(d) {
  const n = d || new Date();
  const day = (n.getDay() + 6) % 7; // 周一=0 ... 周日=6
  const t = new Date(n.getFullYear(), n.getMonth(), n.getDate() - day);
  return t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate();
}

function kvMap(record) {
  const m = {};
  const list = (record && record.KVDataList) || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].key) m[list[i].key] = list[i].value;
  }
  return m;
}

function boardValue(record, board, wk) {
  const m = kvMap(record);
  if (board === 'arena') return parseInt(m.arenaPts, 10) || 0;
  if (board === 'high') return parseInt(m.highScore, 10) || 0;
  if (board === 'streak') {
    // 连胜只在所属周内有效：上周的 streak 不上榜
    return (m.streakWeek === wk) ? (parseInt(m.streak, 10) || 0) : 0;
  }
  return 0;
}

function boardLabel(board) {
  return board === 'arena' ? '积分' : (board === 'high' ? '分' : '连胜');
}

/**
 * 折算榜单行：好友 records + 自己 record 合并去重（按 昵称+头像 匹配）、按 board 值降序。
 * @returns {Array<{name, avatarUrl, value, self}>}
 */
function buildRows(friends, self, board, wk) {
  const rows = [];
  const data = (friends || []).slice();
  if (self) data.push(self);
  const seen = {};
  const rows2 = [];
  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (!r) continue;
    const key = (r.nickname || '') + '|' + (r.avatarUrl || '');
    const v = boardValue(r, board, wk);
    if (seen[key] !== undefined) {
      // 同一好友重复出现（或与自家记录同键）→ 保留值更高的一条
      const prev = rows2[seen[key]];
      if (v > prev.value) prev.value = v;
      if (r === self) prev.self = true;
      continue;
    }
    seen[key] = rows2.length;
    rows2.push({ name: r.nickname || '玩家', avatarUrl: r.avatarUrl || '', value: v, self: r === self });
  }
  rows2.sort((a, b) => b.value - a.value);
  return rows2;
}

// ── 以下为开放数据域运行时（无 wx 的 Node 环境不执行）──
const BOARDS = ['arena', 'high', 'streak'];

function initOpenContext() {
  if (typeof wx === 'undefined' || !wx.getSharedCanvas) return;

  const canvas = wx.getSharedCanvas();
  const ctx = canvas.getContext('2d');
  let board = 'arena';
  let rows = [];
  let myRank = 0;
  let loaded = false;      // 至少成功拉取过一次
  let fetching = false;

  // 头像图缓存（开放数据域内 wx.createImage 加载好友头像 URL 是官方标准做法）
  const _avatars = {};

  function avatarImg(url) {
    if (!url) return null;
    let im = _avatars[url];
    if (im) return im._ok ? im : null;
    try {
      im = wx.createImage();
      im.onload = function () { im._ok = true; render(); };
      im.onerror = function () { im._ok = false; };
      im.src = url;
      _avatars[url] = im;
    } catch (e) { return null; }
    return null;
  }

  function render() {
    const W = canvas.width, H = canvas.height;
    try {
      ctx.clearRect(0, 0, W, H);
      // 底色（与主域面板深色一致）
      ctx.fillStyle = 'rgba(10,6,30,0.35)';
      ctx.fillRect(0, 0, W, H);

      if (!loaded) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('好友榜单加载中…', W / 2, H / 2);
        return;
      }
      if (!rows.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('暂无好友数据', W / 2, H / 2 - 12);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '10px sans-serif';
        ctx.fillText('开发者工具不展示好友 · 请用真机预览', W / 2, H / 2 + 10);
        return;
      }

      // 顶部提示条：被超越 → 复仇 CTA；榜首 → 守住
      myRank = 0;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].self) { myRank = i + 1; break; }
      }
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      if (myRank > 1 && rows[0]) {
        const diff = rows[0].value - rows[myRank - 1].value;
        ctx.fillStyle = 'rgba(255,82,82,0.9)';
        ctx.textAlign = 'center';
        ctx.fillText('⚔ ' + rows[0].name + ' 以 ' + rows[0].value + ' 领先你 ' + diff + '，去复仇！', W / 2, 12);
      } else {
        ctx.fillStyle = 'rgba(255,213,79,0.9)';
        ctx.textAlign = 'center';
        ctx.fillText('👑 你是好友榜第 1，守住！', 0.5 * W, 12);
      }
      // 行
      const rowH = Math.max(30, Math.min(40, (H - 24) / Math.min(rows.length, 5)));
      const y0 = 24;
      const medal = ['#ffd54f', '#cfd8dc', '#cd9a5b'];
      for (let i = 0; i < rows.length && i < 6; i++) {
        const r = rows[i];
        const cy = y0 + i * rowH + rowH / 2;
        // 行底（自己高亮）
        if (r.self) {
          ctx.fillStyle = 'rgba(255,213,79,0.14)';
          ctx.fillRect(4, cy - rowH / 2 + 2, W - 8, rowH - 4);
        }
        // 名次
        ctx.fillStyle = i < 3 ? medal[i] : 'rgba(255,255,255,0.4)';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(i + 1), 18, cy);
        // 头像（未就绪时占位圆，异步 onload 后 render() 重绘）
        const im = avatarImg(r.avatarUrl);
        if (im) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(44, cy, 12, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(im, 32, cy - 12, 24, 24);
          ctx.restore();
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.beginPath();
          ctx.arc(44, cy, 12, 0, Math.PI * 2);
          ctx.fill();
        }
        // 名字
        ctx.fillStyle = r.self ? '#ffd54f' : 'rgba(255,255,255,0.85)';
        ctx.font = (r.self ? 'bold ' : '') + '12px sans-serif';
        ctx.textAlign = 'left';
        let nm = r.name || '玩家';
        while (ctx.measureText(nm).width > W - 150 && nm.length > 2) nm = nm.slice(0, nm.length - 2) + '…';
        ctx.fillText(nm, 64, cy);
        // 分值 + 单位
        ctx.fillStyle = r.self ? '#ffd54f' : 'rgba(255,255,255,0.9)';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(String(r.value), W - 26, cy);
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '9px sans-serif';
        ctx.fillText(boardLabel(board), W - 10, cy);
      }
      if (rows.length > 6) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('仅展示前 6 名', W / 2, H - 8);
      }
    } catch (e) {
      // 渲染失败绝不上抛
    }
  }

  // 主域消息：切榜 / 改尺寸 / 强刷
  try {
    wx.onMessage(function (msg) {
      try {
        if (!msg) return;
        if (msg.type === 'board') {
          if (msg.board && BOARDS.indexOf(msg.board) >= 0) board = msg.board;
          if (msg.w > 0 && msg.h > 0) {
            canvas.width = Math.floor(msg.w);
            canvas.height = Math.floor(msg.h);
          }
          fetchAndRender();
        } else if (msg.type === 'refresh') {
          fetchAndRender();
        }
      } catch (e) {}
    });
  } catch (e) {}

  function fetchAndRender() {
    if (fetching) return;
    fetching = true;
    const wk = weekKeyOf();
    let friends = null;
    let self = null;
    let doneOne = false;
    const finish = function () {
      // 两个回调（好友 + 自己）都返回后才折算渲染；任一失败按空继续
      if (!doneOne) { doneOne = true; return; }
      fetching = false;
      rows = buildRows(friends, self, board, wk);
      loaded = true;
      render();
    };
    try {
      wx.getFriendCloudStorage({
        keyList: ['arenaPts', 'highScore', 'streak', 'streakWeek'],
        success: function (res) { friends = (res && res.data) || []; finish(); },
        fail: function () { friends = friends || []; finish(); }
      });
      if (wx.getUserCloudStorage) {
        wx.getUserCloudStorage({
          keyList: ['arenaPts', 'highScore', 'streak', 'streakWeek'],
          success: function (res) { self = res || null; finish(); },
          fail: function (res) { self = null; finish(); }
        });
      } else { self = null; finish(); }
    } catch (e) {
      fetching = false;
      rows = [];
      loaded = true;
      render();
    }
  }

  // 初始渲染一次（等主域发 board 消息确定尺寸后再真正拉数据）
  render();
}

// Node 无头：只导出纯函数供冒烟测试；开放数据域环境：直接初始化
if (typeof wx !== 'undefined' && wx.getSharedCanvas) {
  try { initOpenContext(); } catch (e) {}
}

module.exports = { weekKeyOf, buildRows, boardValue, boardLabel, kvMap, BOARDS };
