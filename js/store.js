/* ===========================================================
   store.js — 数据层
   负责：localStorage 读写、任务与专注记录管理、简单发布订阅
   API Key 单独存放在另一个 key 里，导出数据时会被剔除
   =========================================================== */

(function (global) {
  'use strict';

  var DATA_KEY = 'focustodo.data.v1';
  var KEY_KEY = 'focustodo.apikey.v1';

  /* ---------- 工具 ---------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // 本地时区的 YYYY-MM-DD，不能用 toISOString（那是 UTC，会跨天错位）
  function dayKey(ts) {
    var d = ts ? new Date(ts) : new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function todayKey() {
    return dayKey(Date.now());
  }

  function defaults() {
    return {
      version: 1,
      tasks: [],
      sessions: [],       // { id, taskId, title, minutes, endedAt }
      activeTaskId: null,
      cycle: 0,           // 当前这一轮里已完成的专注次数，用于长休判断
      settings: {
        focus: 25,
        short: 5,
        long: 15,
        longEvery: 4,
        autoStart: false,
        apiBase: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini'
      }
    };
  }

  /* ---------- 读取与迁移 ---------- */

  function normalize(raw) {
    var base = defaults();
    if (!raw || typeof raw !== 'object') return base;

    var data = {
      version: 1,
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      activeTaskId: raw.activeTaskId || null,
      cycle: typeof raw.cycle === 'number' ? raw.cycle : 0,
      settings: Object.assign(base.settings, raw.settings || {})
    };

    // 任务字段兜底，防止旧数据缺字段导致渲染报错
    data.tasks = data.tasks.map(function (t) {
      return {
        id: t.id || uid(),
        title: String(t.title || '未命名任务'),
        pomos: Math.max(1, Math.min(9, Number(t.pomos) || 1)),
        donePomos: Math.max(0, Number(t.donePomos) || 0),
        done: !!t.done,
        createdAt: t.createdAt || Date.now(),
        doneAt: t.doneAt || null
      };
    });

    data.sessions = data.sessions.filter(function (s) {
      return s && typeof s.minutes === 'number' && s.endedAt;
    });

    return data;
  }

  function load() {
    try {
      var raw = localStorage.getItem(DATA_KEY);
      if (!raw) return defaults();
      return normalize(JSON.parse(raw));
    } catch (err) {
      console.warn('[store] 本地数据解析失败，已回退到初始状态', err);
      return defaults();
    }
  }

  var state = load();
  var listeners = [];
  var saveTimer = null;

  /* ---------- 保存与通知 ---------- */

  function save() {
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(state));
    } catch (err) {
      console.error('[store] 写入 localStorage 失败', err);
    }
  }

  function emit() {
    // 合并同一轮事件循环内的多次通知，避免连续操作时重复重绘
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      save();
      listeners.forEach(function (fn) {
        try { fn(state); } catch (e) { console.error(e); }
      });
    }, 0);
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (f) { return f !== fn; });
    };
  }

  /* ---------- 任务 ---------- */

  function addTask(title, pomos) {
    title = String(title || '').trim();
    if (!title) return null;

    var task = {
      id: uid(),
      title: title,
      pomos: Math.max(1, Math.min(9, Number(pomos) || 1)),
      donePomos: 0,
      done: false,
      createdAt: Date.now(),
      doneAt: null
    };
    state.tasks.unshift(task);
    emit();
    return task;
  }

  function findTask(id) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) return state.tasks[i];
    }
    return null;
  }

  function updateTask(id, patch) {
    var t = findTask(id);
    if (!t) return;
    Object.assign(t, patch);
    emit();
  }

  function removeTask(id) {
    state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
    if (state.activeTaskId === id) state.activeTaskId = null;
    emit();
  }

  function toggleTask(id) {
    var t = findTask(id);
    if (!t) return;
    t.done = !t.done;
    t.doneAt = t.done ? Date.now() : null;
    if (t.done && state.activeTaskId === id) state.activeTaskId = null;
    emit();
  }

  function setActiveTask(id) {
    state.activeTaskId = state.activeTaskId === id ? null : id;
    emit();
  }

  function getActiveTask() {
    return state.activeTaskId ? findTask(state.activeTaskId) : null;
  }

  /* ---------- 专注记录 ---------- */

  // 记录一次完成的专注，并把它算到绑定任务的头上
  function addSession(minutes) {
    var task = getActiveTask();
    var session = {
      id: uid(),
      taskId: task ? task.id : null,
      title: task ? task.title : '未绑定任务',
      minutes: minutes,
      endedAt: Date.now()
    };
    state.sessions.push(session);

    if (task) {
      task.donePomos += 1;
      // 实际投入达到或超过预估时，提示可以收尾了（不改 done，交给用户决定）
      if (task.donePomos > task.pomos) task.pomos = task.donePomos;
    }

    state.cycle += 1;
    emit();
    return session;
  }

  function resetCycle() {
    state.cycle = 0;
    emit();
  }

  function todayStats() {
    var key = todayKey();
    var pomos = 0;
    var minutes = 0;

    state.sessions.forEach(function (s) {
      if (dayKey(s.endedAt) === key) {
        pomos += 1;
        minutes += s.minutes;
      }
    });

    var done = state.tasks.filter(function (t) {
      return t.done && t.doneAt && dayKey(t.doneAt) === key;
    }).length;

    return { pomos: pomos, minutes: minutes, done: done };
  }

  // 返回最近 7 天（含今天）的番茄数，用于柱状图
  function weekSeries() {
    var days = [];
    var now = new Date();

    for (var i = 6; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      days.push({
        key: dayKey(d.getTime()),
        label: ['日', '一', '二', '三', '四', '五', '六'][d.getDay()],
        count: 0,
        isToday: i === 0
      });
    }

    var index = {};
    days.forEach(function (d) { index[d.key] = d; });

    state.sessions.forEach(function (s) {
      var k = dayKey(s.endedAt);
      if (index[k]) index[k].count += 1;
    });

    return days;
  }

  /* ---------- 设置 ---------- */

  function updateSettings(patch) {
    Object.assign(state.settings, patch);
    emit();
  }

  function durationOf(phase) {
    var s = state.settings;
    if (phase === 'short') return s.short;
    if (phase === 'long') return s.long;
    return s.focus;
  }

  /* ---------- API Key（独立存储，永不导出）---------- */

  function getApiKey() {
    try { return localStorage.getItem(KEY_KEY) || ''; } catch (e) { return ''; }
  }

  function setApiKey(key) {
    try {
      if (key) localStorage.setItem(KEY_KEY, key.trim());
      else localStorage.removeItem(KEY_KEY);
    } catch (e) { /* 隐私模式下可能失败，忽略 */ }
  }

  function hasApiKey() {
    return getApiKey().length > 0;
  }

  /* ---------- 导入导出 ---------- */

  function exportData() {
    // 注意：settings 里不含 key，key 存在独立的 localStorage 条目里，
    // 所以导出文件天然不会带上密钥
    return JSON.stringify(state, null, 2);
  }

  function importData(json) {
    var parsed = JSON.parse(json);
    state = normalize(parsed);
    emit();
  }

  function clearAll() {
    state = defaults();
    emit();
  }

  global.Store = {
    get: function () { return state; },
    subscribe: subscribe,
    uid: uid,
    dayKey: dayKey,
    todayKey: todayKey,

    addTask: addTask,
    findTask: findTask,
    updateTask: updateTask,
    removeTask: removeTask,
    toggleTask: toggleTask,
    setActiveTask: setActiveTask,
    getActiveTask: getActiveTask,

    addSession: addSession,
    resetCycle: resetCycle,
    todayStats: todayStats,
    weekSeries: weekSeries,

    updateSettings: updateSettings,
    durationOf: durationOf,

    getApiKey: getApiKey,
    setApiKey: setApiKey,
    hasApiKey: hasApiKey,

    exportData: exportData,
    importData: importData,
    clearAll: clearAll
  };
})(window);
