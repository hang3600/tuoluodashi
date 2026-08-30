/**
 * battle/game.js — 对战子包入口
 *
 * 微信小游戏分包机制要求：每个子包 root 目录下必须存在 game.js 作为子包入口，
 * 否则 DevTools 报「未找到 ["subpackages"][0]["root"] 对应的 /battle/game.js」。
 *
 * 该文件同时承担「依赖图入口」职责：require 对战核心模块，确保 spintop.js 被
 * 微信打包器收进 battle 子包；真正的实例化在 src/main.js 的 _ensureBattle()
 * 里，于 wx.loadSubpackage 成功回调中动态 require('battle/spintop.js')。
 */
// 子包入口：require 对战核心模块，确保 spintop.js 被打包器收进 battle 子包；
// 同时将其导出，供主包 wx.loadSubpackage 成功后 require('../battle/game.js') 取用。
module.exports = require('./spintop.js');
