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

    // 浏览器兼容：鼠标事件
    if (typeof window !== 'undefined') {
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
    // LOW 档低分辨率渲染：触摸坐标是物理像素，需除以 renderScale 映射到逻辑坐标
    // （canvas.renderScale 由 Main 构造时设置，默认 1 不缩放）
    const rs = (this.canvas && this.canvas.renderScale) || 1;
    return {
      id: touch.identifier,
      x: (touch.x || touch.clientX || 0) / rs,
      y: (touch.y || touch.clientY || 0) / rs
    };
  }

  _handleStart(e) {
    // iOS 音频解锁：必须在原生触摸手势内创建并 resume AudioContext（系统限制）。
    // 首触即解锁，且仅执行一次；玩家任何点击/拖拽都会触发，确保首次出声稳定。
    if (!this._audioUnlocked) {
      this._audioUnlocked = true;
      try { if (typeof Sfx !== 'undefined') Sfx.unlock(); } catch (e) {}
    }
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
