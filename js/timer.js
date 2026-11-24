/* ===========================================================
   timer.js — 番茄钟状态机
   不靠 setInterval 累加计时（切到后台会被浏览器节流），
   而是记一个结束时间戳，每次 tick 用 Date.now() 反推剩余量
   =========================================================== */

(function (global) {
  'use strict';

  var PHASES = {
    focus: { label: '专注', chip: '专注中', tip: '别切窗口，就这一件事' },
    short: { label: '短休', chip: '短休息', tip: '站起来走走，别看手机' },
    long: { label: '长休', chip: '长休息', tip: '离开屏幕 15 分钟' }
  };

  function Timer(options) {
    options = options || {};
    this.onTick = options.onTick || function () {};
    this.onPhaseEnd = options.onPhaseEnd || function () {};
    this.onPhaseChange = options.onPhaseChange || function () {};

    this.phase = 'focus';
    this.running = false;
    this.remainMs = this.durationMs('focus');
    this.totalMs = this.remainMs;
    this.endAt = 0;
    this._interval = null;

    var self = this;
    // 从后台切回来时补一次检查，避免停留时间过长导致结束事件延迟
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && self.running) self._tick();
    });
  }

  Timer.prototype.durationMs = function (phase) {
    return Store.durationOf(phase) * 60 * 1000;
  };

  Timer.prototype.state = function () {
    return {
      phase: this.phase,
      running: this.running,
      remainMs: this.remainMs,
      totalMs: this.totalMs,
      progress: this.totalMs ? 1 - this.remainMs / this.totalMs : 0
    };
  };

  Timer.prototype.start = function () {
    if (this.running) return;
    if (this.remainMs <= 0) this.remainMs = this.durationMs(this.phase);

    this.running = true;
    this.endAt = Date.now() + this.remainMs;

    var self = this;
    this._interval = setInterval(function () { self._tick(); }, 200);
    this.onTick(this.state());
  };

  Timer.prototype.pause = function () {
    if (!this.running) return;
    this.remainMs = Math.max(0, this.endAt - Date.now());
    this.running = false;
    clearInterval(this._interval);
    this._interval = null;
    this.onTick(this.state());
  };

  Timer.prototype.toggle = function () {
    this.running ? this.pause() : this.start();
  };

  Timer.prototype.reset = function () {
    this.running = false;
    clearInterval(this._interval);
    this._interval = null;
    this.remainMs = this.durationMs(this.phase);
    this.totalMs = this.remainMs;
    this.onTick(this.state());
  };

  // 跳过当前阶段：专注被跳过时不计入统计，避免刷数据
  Timer.prototype.skip = function () {
    var wasFocus = this.phase === 'focus';
    this.running = false;
    clearInterval(this._interval);
    this._interval = null;

    this._switchTo(wasFocus ? this._nextBreak() : 'focus', false);
    this.onPhaseEnd(this.state(), wasFocus ? 'focus-skipped' : 'break-skipped');
  };

  Timer.prototype._tick = function () {
    this.remainMs = Math.max(0, this.endAt - Date.now());
    this.onTick(this.state());
    if (this.remainMs <= 0) this._complete();
  };

  Timer.prototype._nextBreak = function () {
    var every = Store.get().settings.longEvery || 4;
    var finished = Store.get().cycle;
    return finished > 0 && finished % every === 0 ? 'long' : 'short';
  };

  Timer.prototype._complete = function () {
    this.running = false;
    clearInterval(this._interval);
    this._interval = null;

    var donePhase = this.phase;

    if (donePhase === 'focus') {
      // 只有真正跑完的专注才记账
      Store.addSession(Math.round(this.totalMs / 60000));
      this._switchTo(this._nextBreak(), true);
    } else {
      // 长休结束，重置这一轮的计数
      if (donePhase === 'long') Store.resetCycle();
      this._switchTo('focus', true);
    }

    this.onPhaseEnd(this.state(), donePhase);
  };

  Timer.prototype._switchTo = function (phase, autoStart) {
    this.phase = phase;
    this.remainMs = this.durationMs(phase);
    this.totalMs = this.remainMs;

    this.onPhaseChange(this.state());
    this.onTick(this.state());

    if (autoStart && Store.get().settings.autoStart) this.start();
  };

  // 设置里改了时长后调用：没在跑就立即套用新时长
  Timer.prototype.refreshDuration = function () {
    if (this.running) return;
    this.remainMs = this.durationMs(this.phase);
    this.totalMs = this.remainMs;
    this.onTick(this.state());
  };

  Timer.PHASES = PHASES;
  global.PomodoroTimer = Timer;
})(window);
