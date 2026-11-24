/* ===========================================================
   stats.js — 统计展示
   顶栏三个数字 + 最近 7 天柱状图，纯 DOM 手写，不引图表库
   =========================================================== */

(function (global) {
  'use strict';

  function el(id) { return document.getElementById(id); }

  function renderTopbar() {
    var s = Store.todayStats();
    el('todayPomos').textContent = s.pomos;
    el('todayMinutes').textContent = s.minutes;
    el('todayDone').textContent = s.done;
  }

  function renderWeek() {
    var series = Store.weekSeries();
    var wrap = el('weekBars');
    var total = 0;

    // 基准取「最大值」和「4」中较大的那个，柱子不会因为只有 1 个番茄就顶满
    var max = 4;
    series.forEach(function (d) {
      total += d.count;
      if (d.count > max) max = d.count;
    });

    wrap.innerHTML = '';
    series.forEach(function (d) {
      var col = document.createElement('div');
      col.className = 'bar-col' + (d.isToday ? ' today' : '');

      var bar = document.createElement('div');
      bar.className = 'bar' + (d.count ? ' has' : '') + (d.isToday ? ' today' : '');
      var h = d.count ? Math.max(8, Math.round((d.count / max) * 62)) : 4;
      bar.style.height = h + 'px';
      bar.title = d.key + '：' + d.count + ' 个番茄';

      var label = document.createElement('span');
      label.className = 'bar-label';
      label.textContent = d.isToday ? '今' : d.label;

      col.appendChild(bar);
      col.appendChild(label);
      wrap.appendChild(col);
    });

    el('weekTotal').textContent = total + ' 个番茄';
  }

  global.Stats = {
    render: function () {
      renderTopbar();
      renderWeek();
    }
  };
})(window);
