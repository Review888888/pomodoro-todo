/* ===========================================================
   tasks.js — 任务清单渲染与交互
   点整行 = 绑定到番茄钟；双击标题 = 重命名；勾选框 = 完成
   =========================================================== */

(function (global) {
  'use strict';

  function el(id) { return document.getElementById(id); }

  var SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
  var SVG_BIND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>';
  var SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';

  var editingId = null;

  function sortedTasks() {
    return Store.get().tasks.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return b.createdAt - a.createdAt;
    });
  }

  function buildPomoDots(task) {
    var shown = Math.min(Math.max(task.pomos, 1), 6);
    var dots = document.createElement('div');
    dots.className = 'pomo-dots';
    for (var i = 0; i < shown; i++) {
      var dot = document.createElement('i');
      if (i < task.donePomos) dot.className = 'filled';
      dots.appendChild(dot);
    }
    return dots;
  }

  function buildTask(task) {
    var state = Store.get();
    var isActive = state.activeTaskId === task.id;

    var li = document.createElement('li');
    li.className = 'task' + (task.done ? ' done' : '') + (isActive ? ' active' : '');
    li.dataset.id = task.id;

    var check = document.createElement('button');
    check.className = 'check';
    check.setAttribute('aria-label', task.done ? '标记为未完成' : '标记为完成');
    check.innerHTML = SVG_CHECK;
    li.appendChild(check);

    var main = document.createElement('div');
    main.className = 'task-main';

    if (editingId === task.id) {
      var input = document.createElement('input');
      input.className = 'edit-input';
      input.value = task.title;
      input.maxLength = 80;
      main.appendChild(input);
      // 渲染完成后再聚焦，光标放到末尾
      setTimeout(function () {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }, 0);
    } else {
      var title = document.createElement('button');
      title.className = 'task-title';
      title.type = 'button';
      title.textContent = task.title;
      title.title = '双击可重命名';
      main.appendChild(title);
    }

    var meta = document.createElement('div');
    meta.className = 'task-meta';
    meta.appendChild(buildPomoDots(task));

    var pomoText = document.createElement('span');
    pomoText.className = 'pomo-text';
    pomoText.textContent = task.donePomos + '/' + task.pomos + ' 番茄';
    meta.appendChild(pomoText);
    main.appendChild(meta);

    li.appendChild(main);

    var actions = document.createElement('div');
    actions.className = 'task-actions';

    var bind = document.createElement('button');
    bind.className = 'bind' + (isActive ? ' on' : '');
    bind.innerHTML = SVG_BIND;
    bind.title = isActive ? '取消绑定' : '设为当前任务';
    actions.appendChild(bind);

    var del = document.createElement('button');
    del.className = 'del';
    del.innerHTML = SVG_TRASH;
    del.title = '删除';
    actions.appendChild(del);

    li.appendChild(actions);
    return li;
  }

  function renderCurrentTask() {
    var task = Store.getActiveTask();
    var box = el('currentTaskName');

    if (task) {
      box.textContent = task.title;
      box.classList.remove('empty');
    } else {
      box.textContent = '未绑定（点任务右侧的圆点绑定）';
      box.classList.add('empty');
    }
  }

  function render() {
    var list = el('taskList');
    var tasks = sortedTasks();

    list.innerHTML = '';
    tasks.forEach(function (t) { list.appendChild(buildTask(t)); });

    var total = tasks.length;
    var done = tasks.filter(function (t) { return t.done; }).length;
    el('taskCounter').textContent = done + ' / ' + total;

    el('emptyState').style.display = total ? 'none' : 'block';
    renderCurrentTask();
  }

  /* ---------- 事件代理 ---------- */

  function commitEdit(li, id, value) {
    var title = String(value || '').trim();
    if (title) Store.updateTask(id, { title: title });
    editingId = null;
    render();
  }

  function bindEvents() {
    var list = el('taskList');

    list.addEventListener('click', function (e) {
      var li = e.target.closest('.task');
      if (!li) return;
      var id = li.dataset.id;
      var task = Store.findTask(id);
      if (!task) return;

      if (e.target.closest('.check')) {
        Store.toggleTask(id);
        return;
      }
      if (e.target.closest('.del')) {
        if (confirm('删除「' + task.title + '」？专注记录会保留。')) Store.removeTask(id);
        return;
      }
      if (e.target.closest('.bind')) {
        Store.setActiveTask(id);
        return;
      }
      // 点行内其它区域 = 绑定当前任务
      if (!e.target.closest('.edit-input')) {
        Store.setActiveTask(id);
      }
    });

    list.addEventListener('dblclick', function (e) {
      var titleEl = e.target.closest('.task-title');
      if (!titleEl) return;
      var li = titleEl.closest('.task');
      editingId = li.dataset.id;
      render();
    });

    list.addEventListener('keydown', function (e) {
      var input = e.target.closest('.edit-input');
      if (!input) return;
      var li = input.closest('.task');
      var id = li.dataset.id;

      if (e.key === 'Enter') {
        e.preventDefault();
        commitEdit(li, id, input.value);
      } else if (e.key === 'Escape') {
        editingId = null;
        render();
      }
    });

    list.addEventListener('focusout', function (e) {
      var input = e.target.closest('.edit-input');
      if (!input) return;
      var li = input.closest('.task');
      // 用 setTimeout 让 Enter 的处理先跑完，避免重复提交
      setTimeout(function () {
        if (editingId && Store.findTask(li.dataset.id) && document.body.contains(input)) {
          commitEdit(li, li.dataset.id, input.value);
        }
      }, 80);
    });

    el('addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = el('taskInput');
      var pomo = el('pomoInput');
      var task = Store.addTask(input.value, pomo.value);
      if (!task) {
        input.focus();
        return;
      }
      input.value = '';
      input.focus();
      document.title = '番茄待办 · FocusTodo';
    });
  }

  global.Tasks = {
    render: render,
    init: bindEvents
  };
})(window);
