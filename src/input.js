/**
 * 输入处理：触摸/点击
 */

const { isPointInRect } = require('./utils');
const { Sfx } = require('./audio');

class InputHandler {
  constructor(canvas) {
    this.canvas = canvas;
    this.touches = [];
    this.lastTap = { x: 0, y: 0, time: 0 };
    this.onTap = null;
    this.onDragStart = null;
    this.onDragMove = null;
    this.onDragEnd = null;
    this.onLongPress = null;

    this._bindEvents();
  }

  _bindEvents() {
    // 微信小游戏触摸事件
    if (typeof wx !== 'undefined' && wx.onTouchStart) {
      wx.onTouchStart(this._handleStart.bind(this));
      wx.onTouchMove(this._handleMove.bind(this));
      wx.onTouchEnd(this._handleEnd.bind(this));
      wx.onTouchCancel(this._handleEnd.bind(this));
    }

    // 浏览器兼容：鼠标事件。
    // ⚠️ 必须做能力检测而非只判 window 存在：开放数据域等环境可能带 window shim，
    // 但 canvas 上没有 addEventListener —— 直接注册会在启动期抛
    // 「this.canvas.addEventListener is not a function」（WAGameSubContext 环境实测）。
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        && this.canvas && typeof this.canvas.addEventListener === 'function') {
      this.canvas.addEventListener('mousedown', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const t = { identifier: 'mouse', x: e.clientX - rect.left, y: e.clientY - rect.top };
        this._handleStart({ touches: [t], changedTouches: [t] });
      });
      window.addEventListener('mousemove', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const t = { identifier: 'mouse', x: e.clientX - rect.left, y: e.clientY - rect.top };
        this._handleMove({ touches: [t], changedTouches: [t] });
      });
      window.addEventListener('mouseup', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const t = { identifier: 'mouse', x: e.clientX - rect.left, y: e.clientY - rect.top };
        this._handleEnd({ touches: [], changedTouches: [t] });
      });
    }
  }

  _normalize(touch) {
    // 微信小游戏 touch 事件的 x/y 已经是「逻辑像素」，与渲染逻辑坐标 cw/ch、windowWidth
    // 同坐标系，**不需要除以 DPR/renderScale**。
    // 旧代码除以 canvas.renderScale(=dpr) 是错误假设 touch 为物理像素，导致 dpr=2/3 时
    // 点击落点被缩小 2~3 倍、偏到画面角落，表现为「点击无响应」（开发者工具/真机皆然）。
    // 浏览器兼容路径传入的 x = clientX - rect.left 也是相对 canvas 的逻辑像素，同样直接使用。
    const x = (typeof touch.x === 'number') ? touch.x : (touch.clientX || 0);
    const y = (typeof touch.y === 'number') ? touch.y : (touch.clientY || 0);
    return { id: touch.identifier, x: x || 0, y: y || 0 };
  }

  _handleStart(e) {
    // iOS 音频解锁：必须在原生触摸手势内创建并 resume AudioContext（系统限制）。
    // 首触即解锁，且仅执行一次；玩家任何点击/拖拽都会触发，确保首次出声稳定。
    if (!this._audioUnlocked) {
      this._audioUnlocked = true;
      try { if (typeof Sfx !== 'undefined') Sfx.unlock(); } catch (e) {}
    }
    // #5 跨平台自愈：Android 无 onAudioInterruption 事件，来电/其他 App 抢音频且未进后台时
    // AudioContext 会被挂起且 onShow 不触发；每次触摸都尝试恢复，确保下一次交互即自愈。
    try { if (typeof Sfx !== 'undefined' && Sfx.ensureRunning) Sfx.ensureRunning(); } catch (e) {}
    for (const t of e.changedTouches) {
      const p = this._normalize(t);
      const item = { id: p.id, x: p.x, y: p.y, startX: p.x, startY: p.y, moved: false, longPressed: false };
      item.longTimer = setTimeout(() => {
        if (!item.moved && this.touches.indexOf(item) >= 0) {
          item.longPressed = true;
          if (this.onLongPress) this.onLongPress({ x: item.x, y: item.y });
        }
      }, 450);
      this.touches.push(item);
    }
    if (this.onDragStart) this.onDragStart(this.touches[this.touches.length - 1]);
  }

  _handleMove(e) {
    for (const t of e.changedTouches) {
      const p = this._normalize(t);
      const idx = this.touches.findIndex(item => item.id === p.id);
      if (idx >= 0) {
        const item = this.touches[idx];
        const dx = p.x - item.startX;
        const dy = p.y - item.startY;
        if (Math.hypot(dx, dy) > 8) {
          item.moved = true;
          clearTimeout(item.longTimer);
        }
        item.x = p.x;
        item.y = p.y;
      }
    }
    if (this.onDragMove) this.onDragMove(this.touches);
  }

  _handleEnd(e) {
    for (const t of e.changedTouches) {
      const p = this._normalize(t);
      const idx = this.touches.findIndex(item => item.id === p.id);
      if (idx >= 0) {
        const item = this.touches[idx];
        clearTimeout(item.longTimer);
        const now = Date.now();
        // 长按已处理：跳过点击，仍交给 dragEnd 清理
        if (item.longPressed) {
          if (this.onDragEnd) this.onDragEnd(item);
          this.touches.splice(idx, 1);
          continue;
        }
        if (!item.moved) {
          this.lastTap = { x: item.x, y: item.y, time: now };
          if (this.onTap) this.onTap({ x: item.x, y: item.y });
        }
        if (this.onDragEnd) this.onDragEnd(item);
        this.touches.splice(idx, 1);
      }
    }
  }

  getTouch() {
    return this.touches[0] || null;
  }
}

module.exports = { InputHandler };
