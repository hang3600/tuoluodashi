/**
 * 运营/业务统一配置
 * - 集中管理需要替换为真实值的对外标识，避免散落在各处难以维护。
 * - 所有配置改动只需修改本文件，无需改业务逻辑。
 */
const CONFIG = {
  // 产品版本号：随每次发布 bump，用于版本展示 / 强更判断等。
  // 注：小游戏埋点走「场景分析 / 分支曝光上报」(wx.reportUserBehaviorBranchAnalytics)，
  //     该接口 branchDim 仅接受 1-100 整数、放不下版本号，故埋点改用「发布前后时间段对比」
  //     （见 analytics.js），不再依赖此字段做切片。
  version: '1.0.0',

  // 激励视频广告位 ID（单一真源；已确认为真实流量主广告位 adunit-1183de0d72298c4d，上线前勿改）
  adUnitId: 'adunit-1183de0d72298c4d',

  // 插屏广告位 ID（隐藏式自动弹广告用）—— ⚠️ 与上面激励视频是「两套独立广告位」！
  // 必须去 MP 后台「流量主 → 广告位 → 插屏广告」单独新建一个，把分配的新 ID 填这里；
  // 不能直接复用上面的激励视频 ID（类型不同，复用会被微信拒绝/不展示）。
  // 单一点位已确认：adunit-6543c4bf1cb6c43f（插屏广告位 ID，2026-08-30 用户回填）。
  interstitialAdUnitId: 'adunit-6543c4bf1cb6c43f',

  // 游戏圈 openlink：必须是短 token（形如 xxxxxxx-xxxxxx），不是浏览器 URL。
  // 唯一正确取法：登录 mp.weixin.qq.com → 游戏能力地图 → 游戏圈 → 基础设置 / 帖子·话题列表，
  // 复制那里的 openlink 原文覆盖此处。
  //
  // 留空时的行为（重要）：胶囊左侧的「社区」入口**不会渲染**，玩家看不到、也没有任何提示。
  // 所以该入口永远不会是"点了没反应"的死按钮 —— 配好即出现，没配就不出现。
  gameClubOpenlink: '',

  // 更多小游戏 openlink：与 gameClubOpenlink 同源，留空则胶囊左侧「更多小游戏」入口**不渲染**，
  // 避免"点了只弹敬请期待"的死按钮（P2-8）。配好聚合页/跳转盒子 openlink 后入口自动出现，
  // 点击走 wx.createPageManager().load({openlink}) 真实跳转。
  moreGamesOpenlink: '',

  // 场景分析 / 分支曝光上报的 branchId（小游戏专用，对应 wx.reportUserBehaviorBranchAnalytics）。
  // 三个场景在 MP 后台「统计 → 基础数据 → 场景分析 → 场景管理」各建一个，把分配的 branchId 填进来：
  //   boot            启动
  //   battleStart     每局开始（branchDim 自动传 stage 关卡号 1-100）
  //   firstBattleDone 首局完成（每用户一生仅一次）
  // 留空 = 不上报（避免空打）；填好即自动生效，无需改业务逻辑。
  analyticsBranch: {
    boot: '',
    battleStart: '',
    firstBattleDone: ''
  },

  // 分享卡片图片
  shareCardImage: 'images/share-card.jpg'
};

module.exports = {
  CONFIG
};