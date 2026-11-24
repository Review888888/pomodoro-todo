/* ===========================================================
   app.js — 启动与装配
   把 store / timer / tasks / stats / ai 串起来，处理弹层与快捷键
   =========================================================== */

(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }

  var modal = el('modal');
  var modalBody = el('modalBody');
  var modalFoot = el('modalFoot');
  var modalTitle = el('modalTitle');

  var currentKind = null;   // 'breakdown' | 'review' | 'settings'
  var aiItems = [];         // 上一次拆解出来的候选子任务
  var toastTimer = null;
  var titleFlash = null;

  /* ---------- 通用小工具 ---------- */

  function toast(msg) {
    var box = el('toast');
    box.textContent = msg;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.hidden = true; }, 2600);
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmtTime(ms) {
    var total = Math.ceil(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return pad(m) + ':' + pad(s);
  }

  var audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      // 三声短提示音，频率递进，听起来像「叮-叮-叮」
      [0, 0.22, 0.44].forEach(function (offset, i) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 660 + i * 120;
        var t = audioCtx.currentTime + offset;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.2);
      });
    } catch (e) { /* 用户还没交互过时浏览器会拦截，忽略即可 */ }
  }

  /* ---------- 番茄钟渲染 ---------- */

  var CIRCUMFERENCE = 2 * Math.PI * 98;

  var timer = new PomodoroTimer({
    onTick: renderTimer,
    onPhaseEnd: handlePhaseEnd,
    onPhaseChange: handlePhaseChange
  });

  function renderTimer(st) {
    var phase = PomodoroTimer.PHASES[st.phase];
    var isFocus = st.phase === 'focus';

    el('timeText').textContent = fmtTime(st.remainMs);
    el('ringProgress').style.strokeDashoffset = String(CIRCUMFERENCE * (1 - st.remainMs / st.totalMs));
    el('ringProgress').classList.toggle('break', !isFocus);

    var chip = el('modeChip');
    chip.textContent = st.running ? phase.chip : phase.label;
    chip.classList.toggle('break', !isFocus);

    el('ringCaption').textContent = st.running ? phase.tip : (st.remainMs === st.totalMs ? '按空格或点开始' : '已暂停');

    var btn = el('btnStart');
    btn.textContent = st.running ? '暂停' : (st.remainMs < st.totalMs ? '继续' : (isFocus ? '开始专注' : '开始休息'));
    btn.classList.toggle('running', st.running);

    // 标题栏同步倒计时，切到别的标签页也能看到还剩多久
    if (st.running) {
      document.title = fmtTime(st.remainMs) + ' · ' + (isFocus ? '专注中' : '休息中');
    } else {
      document.title = '番茄待办 · FocusTodo';
    }

    renderCycleDots();
  }

  function renderCycleDots() {
    var state = Store.get();
    var every = state.settings.longEvery || 4;
    var filled = state.cycle % every;
    if (state.cycle > 0 && filled === 0) filled = every;

    var wrap = el('cycleDots');
    wrap.innerHTML = '';
    for (var i = 0; i < every; i++) {
      var dot = document.createElement('i');
      if (i < filled) dot.className = 'on';
      wrap.appendChild(dot);
    }
  }

  function handlePhaseChange() {
    renderCycleDots();
  }

  function handlePhaseEnd(st, donePhase) {
    beep();

    if (donePhase === 'focus') {
      var isLong = st.phase === 'long';
      toast('专注结束，' + (isLong ? '休息 ' + Store.durationOf('long') : '休息 ' + Store.durationOf('short')) + ' 分钟');
      flashTitle('该休息了');
    } else if (donePhase === 'focus-skipped') {
      toast('已跳过这一轮专注，不计入统计');
    } else if (donePhase === 'break-skipped') {
      toast('休息结束，回到专注');
    } else {
      toast('休息结束，开始下一个番茄');
      flashTitle('继续专注');
    }

    Stats.render();
    Tasks.render();
  }

  function flashTitle(text) {
    clearInterval(titleFlash);
    var n = 0;
    titleFlash = setInterval(function () {
      document.title = n % 2 === 0 ? '⏰ ' + text : '番茄待办 · FocusTodo';
      if (++n > 7) {
        clearInterval(titleFlash);
        document.title = '番茄待办 · FocusTodo';
      }
    }, 700);
  }

  /* ---------- 弹层 ---------- */

  function openModal(kind, title, bodyHTML, footHTML) {
    currentKind = kind;
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHTML;
    modalFoot.hidden = !footHTML;
    if (footHTML) modalFoot.innerHTML = footHTML;
    modal.hidden = false;

    // 第一项可输入控件自动聚焦
    var first = modalBody.querySelector('input, textarea');
    if (first) setTimeout(function () { first.focus(); }, 30);
  }

  function closeModal() {
    modal.hidden = true;
    modalBody.innerHTML = '';
    currentKind = null;
    aiItems = [];
  }

  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });
  el('modalClose').addEventListener('click', closeModal);
  el('modalCancel').addEventListener('click', closeModal);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  /* ---------- AI 拆解 ---------- */

  function openBreakdown() {
    var prefill = el('taskInput').value.trim();

    openModal('breakdown', 'AI 拆解任务', [
      '<p class="modal-desc">写下一件让你拖着不想动的事，AI 会把它拆成几个能立刻上手的小步骤。拆完可以只挑想做的加入清单。</p>',
      '<textarea id="aiInput" rows="2" placeholder="例如：准备下周三的操作系统实验报告">' + escapeHTML(prefill) + '</textarea>',
      '<div class="modal-actions">',
      '  <button class="btn primary" id="aiRun">开始拆解</button>',
      '  <span class="hint" id="aiHint">当前模式：' + (Store.hasApiKey() ? '已连接模型' : '本地规则（未填 Key）') + '</span>',
      '</div>',
      '<ul class="ai-result" id="aiResult"></ul>'
    ].join(''), '');

    el('aiRun').addEventListener('click', runBreakdown);
    el('aiInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runBreakdown();
    });
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function runBreakdown() {
    var input = el('aiInput');
    var title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }

    var btn = el('aiRun');
    var hint = el('aiHint');
    btn.disabled = true;
    btn.textContent = '拆解中…';
    hint.textContent = '正在生成，请稍等';

    var result = await AI.breakdown(title);
    aiItems = result.items;

    var list = el('aiResult');
    list.innerHTML = '';

    result.items.forEach(function (item, i) {
      var li = document.createElement('li');
      li.className = 'ai-item';
      li.style.animationDelay = (i * 40) + 'ms';

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.dataset.index = String(i);

      var span = document.createElement('span');
      span.className = 'ai-title';
      span.textContent = item.title;

      var pomo = document.createElement('span');
      pomo.className = 'ai-pomo';
      pomo.textContent = item.pomos + ' 番茄';

      li.appendChild(box);
      li.appendChild(span);
      li.appendChild(pomo);
      list.appendChild(li);
    });

    btn.disabled = false;
    btn.textContent = '重新拆解';
    hint.textContent = result.source === 'remote'
      ? '由模型生成'
      : (result.error ? '模型调用失败，已用本地规则：' + result.error : '本地规则生成');

    modalFoot.hidden = false;
    modalFoot.innerHTML = '<button class="btn ghost" id="modalCancel">取消</button>' +
                          '<button class="btn primary" id="aiAdd">加入清单</button>';
    el('modalCancel').addEventListener('click', closeModal);
    el('aiAdd').addEventListener('click', addAiItems);
  }

  function addAiItems() {
    var boxes = modalBody.querySelectorAll('.ai-item input[type="checkbox"]');
    var count = 0;

    boxes.forEach(function (box) {
      if (!box.checked) return;
      var item = aiItems[Number(box.dataset.index)];
      if (item) {
        Store.addTask(item.title, item.pomos);
        count++;
      }
    });

    closeModal();
    el('taskInput').value = '';
    toast(count ? '已加入 ' + count + ' 个子任务' : '没有选中任何子任务');
  }

  /* ---------- AI 复盘 ---------- */

  async function openReview() {
    openModal('review', 'AI 今日复盘',
      '<p class="modal-desc">根据今天的番茄数和任务完成情况生成，不做额外猜测。</p>' +
      '<div class="review-box" id="reviewBox">正在整理今天的数据…</div>',
      '');

    var res = await AI.review();
    var box = el('reviewBox');
    if (box) {
      box.textContent = res.text;
      if (res.source === 'local') {
        var tag = document.createElement('div');
        tag.className = 'hint';
        tag.style.marginTop = '10px';
        tag.textContent = res.error ? '模型调用失败，已回退本地模板：' + res.error : '';
        if (tag.textContent) box.appendChild(tag);
      }
    }
  }

  /* ---------- 设置 ---------- */

  function openSettings() {
    var s = Store.get().settings;

    openModal('settings', '设置', [
      '<div class="setting-group">',
      '  <h4>时长（分钟）</h4>',
      '  <div class="setting-grid four">',
      '    <label class="field"><span>专注</span><input type="number" id="setFocus" min="1" max="90" value="' + s.focus + '"></label>',
      '    <label class="field"><span>短休</span><input type="number" id="setShort" min="1" max="30" value="' + s.short + '"></label>',
      '    <label class="field"><span>长休</span><input type="number" id="setLong" min="1" max="60" value="' + s.long + '"></label>',
      '    <label class="field"><span>长休间隔</span><input type="number" id="setEvery" min="2" max="8" value="' + s.longEvery + '"></label>',
      '  </div>',
      '  <label class="note" style="display:flex;align-items:center;gap:8px;cursor:pointer">',
      '    <input type="checkbox" id="setAuto"' + (s.autoStart ? ' checked' : '') + '> 阶段结束后自动开始下一段',
      '  </label>',
      '</div>',

      '<div class="setting-group">',
      '  <h4>AI 接口（OpenAI 兼容）</h4>',
      '  <div class="setting-grid">',
      '    <label class="field full"><span>Base URL</span><input id="setBase" value="' + escapeHTML(s.apiBase) + '" placeholder="https://api.openai.com/v1"></label>',
      '    <label class="field"><span>模型</span><input id="setModel" value="' + escapeHTML(s.model) + '" placeholder="gpt-4o-mini"></label>',
      '    <label class="field full"><span>API Key</span><input id="setKey" type="password" placeholder="留空则使用本地规则" value=""></label>',
      '  </div>',
      '  <p class="note">Key 保存在本机浏览器的 localStorage，<b>不写进代码、不会出现在导出文件里</b>。这个仓库是公开的，请不要把 Key 提交到 git。当前状态：<b>' +
        (Store.hasApiKey() ? '已填写' : '未填写') + '</b>。</p>',
      '</div>',

      '<div class="setting-group">',
      '  <h4>数据</h4>',
      '  <div class="setting-actions">',
      '    <button class="btn ghost" id="btnExport" type="button">导出 JSON</button>',
      '    <button class="btn ghost" id="btnImport" type="button">导入 JSON</button>',
      '    <button class="btn ghost" id="btnClear" type="button">清空数据</button>',
      '  </div>',
      '</div>'
    ].join(''), '<button class="btn ghost" id="modalCancel">取消</button><button class="btn primary" id="saveSettings">保存</button>');

    el('modalCancel').addEventListener('click', closeModal);
    el('saveSettings').addEventListener('click', saveSettings);
    el('btnExport').addEventListener('click', exportJson);
    el('btnImport').addEventListener('click', importJson);
    el('btnClear').addEventListener('click', function () {
      if (confirm('确定清空所有任务和专注记录？建议先导出备份。')) {
        Store.clearAll();
        closeModal();
        toast('已清空');
      }
    });
  }

  function saveSettings() {
    function num(id, fallback, min, max) {
      var v = Number(el(id).value);
      if (!v || isNaN(v)) return fallback;
      return Math.max(min, Math.min(max, Math.round(v)));
    }

    Store.updateSettings({
      focus: num('setFocus', 25, 1, 90),
      short: num('setShort', 5, 1, 30),
      long: num('setLong', 15, 1, 60),
      longEvery: num('setEvery', 4, 2, 8),
      autoStart: el('setAuto').checked,
      apiBase: el('setBase').value.trim() || 'https://api.openai.com/v1',
      model: el('setModel').value.trim() || 'gpt-4o-mini'
    });

    var keyInput = el('setKey').value.trim();
    if (keyInput) Store.setApiKey(keyInput);

    timer.refreshDuration();
    updateAiBadge();
    closeModal();
    toast('设置已保存');
  }

  function exportJson() {
    var blob = new Blob([Store.exportData()], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'focustodo-' + Store.todayKey() + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出（不含 API Key）');
  }

  function importJson() {
    var picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'application/json,.json';
    picker.addEventListener('change', function () {
      var file = picker.files && picker.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          Store.importData(String(reader.result));
          closeModal();
          toast('导入成功');
        } catch (err) {
          alert('导入失败：文件格式不对（' + err.message + '）');
        }
      };
      reader.readAsText(file);
    });
    picker.click();
  }

  function updateAiBadge() {
    var badge = el('aiMode');
    var remote = Store.hasApiKey();
    badge.textContent = remote ? 'AI 在线' : '本地规则';
    badge.classList.toggle('online', remote);
    badge.title = remote ? '已填 Key，拆解和复盘走模型' : '没填 Key，用内置规则生成，功能一样能用';
  }

  /* ---------- 启动 ---------- */

  function init() {
    Tasks.init();
    Stats.render();
    Tasks.render();
    renderTimer(timer.state());
    updateAiBadge();

    Store.subscribe(function () {
      Tasks.render();
      Stats.render();
      updateAiBadge();
    });

    // 点开始会顺带触发一次用户交互，浏览器才允许后面播放提示音
    el('btnStart').addEventListener('click', function () { timer.toggle(); });
    el('btnReset').addEventListener('click', function () { timer.reset(); });
    el('btnSkip').addEventListener('click', function () { timer.skip(); });

    el('openSettings').addEventListener('click', openSettings);
    el('btnBreakdown').addEventListener('click', openBreakdown);
    el('btnReview').addEventListener('click', openReview);

    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

      if (e.code === 'Space' && !typing && tag !== 'button') {
        e.preventDefault();
        timer.toggle();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
