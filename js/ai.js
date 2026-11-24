/* ===========================================================
   ai.js — AI 能力层（双通道）
   1) 远程：填了 API Key，就走 OpenAI 兼容的 /chat/completions
   2) 本地：没有 Key，用关键词规则 + 模板生成，保证功能永远可用
   Key 只存在浏览器 localStorage，不写进代码，也不会被导出
   =========================================================== */

(function (global) {
  'use strict';

  /* ---------- 远程调用 ---------- */

  function endpoint() {
    var base = (Store.get().settings.apiBase || '').trim().replace(/\/+$/, '');
    return base + '/chat/completions';
  }

  async function chat(messages, temperature) {
    var key = Store.getApiKey();
    if (!key) throw new Error('NO_KEY');

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 30000);

    try {
      var res = await fetch(endpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key
        },
        body: JSON.stringify({
          model: Store.get().settings.model || 'gpt-4o-mini',
          messages: messages,
          temperature: typeof temperature === 'number' ? temperature : 0.4
        }),
        signal: ctrl.signal
      });

      if (!res.ok) {
        var detail = '';
        try {
          var errJson = await res.json();
          detail = (errJson.error && errJson.error.message) || '';
        } catch (e) { /* 响应体不是 JSON，忽略 */ }
        throw new Error('HTTP ' + res.status + (detail ? '：' + detail : ''));
      }

      var data = await res.json();
      var content = data && data.choices && data.choices[0] &&
                    data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('接口没有返回内容');
      return content.trim();
    } catch (err) {
      // fetch 的原始报错对用户毫无意义，这里翻译成能看懂的原因
      if (err.name === 'AbortError') {
        throw new Error('请求超时，30 秒内没有响应');
      }
      if (err instanceof TypeError) {
        throw new Error('网络请求发不出去，可能是跨域被拦或网络不通');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 模型有时会裹一层 ```json，这里做一次宽松解析
  function parseJsonArray(text) {
    var cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();

    try {
      var parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    } catch (e) { /* 继续用正则兜底 */ }

    var match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e) { /* 放弃 */ }
    }
    return null;
  }

  /* ---------- 本地规则：任务拆解 ---------- */

  var RULES = [
    {
      name: '写作',
      keys: ['报告', '论文', '作文', '总结', '文档', '策划', 'ppt', '汇报', '方案', '教案', '简历'],
      steps: [
        ['列出提纲，明确要写哪几部分', 1],
        ['收集需要的资料和数据', 1],
        ['写完主体内容，先不纠结措辞', 2],
        ['通读一遍，改逻辑漏洞和格式', 1]
      ]
    },
    {
      name: '备考',
      keys: ['考试', '复习', '备考', '背诵', '期末', '考研', '四六级', '刷题', '预习'],
      steps: [
        ['整理这门课的知识清单，知道自己缺什么', 1],
        ['过一遍重点章节，标出没看懂的地方', 2],
        ['做一套真题或课后题，限时', 1],
        ['回看错题，只补最薄弱的两个点', 1]
      ]
    },
    {
      name: '编码',
      keys: ['代码', '编程', '项目', '程序', '网站', '算法', '实验', '开发', 'bug', '接口', '部署', '前端', '后端'],
      steps: [
        ['把需求拆成明确的输入和输出', 1],
        ['先跑通一个最小可运行版本', 2],
        ['补上核心功能和异常处理', 2],
        ['自测、清理代码、写使用说明', 1]
      ]
    },
    {
      name: '学习',
      keys: ['看', '读', '学', '课程', '视频', '书', '教程', '网课', '公开课'],
      steps: [
        ['先扫一遍目录和标题，标出要重点看的部分', 1],
        ['精读核心章节，随手记下疑问', 2],
        ['合上材料复述一遍，找出说不清的地方', 1]
      ]
    },
    {
      name: '整理',
      keys: ['整理', '收拾', '归档', '清理', '备份', '分类', '搬家', '打扫'],
      steps: [
        ['划定范围，把东西全摊开看清楚', 1],
        ['按用途分类，扔掉明显用不上的', 1],
        ['归位，并定一条以后维持的规则', 1]
      ]
    },
    {
      name: '事务',
      keys: ['报名', '申请', '联系', '开会', '提交', '交', '预约', '办', '跑腿', '材料'],
      steps: [
        ['确认要准备什么、截止时间是什么时候', 1],
        ['把材料或内容准备好', 1],
        ['提交 / 联系对方，并确认已收到', 1]
      ]
    }
  ];

  var FALLBACK = [
    ['先做 25 分钟就能动手的那一小步', 1],
    ['完成主体部分', 2],
    ['收尾检查，确认可以标记完成', 1]
  ];

  function matchRule(title) {
    var lower = title.toLowerCase();
    for (var i = 0; i < RULES.length; i++) {
      for (var j = 0; j < RULES[i].keys.length; j++) {
        if (lower.indexOf(RULES[i].keys[j]) !== -1) return RULES[i];
      }
    }
    return null;
  }

  function localBreakdown(title) {
    title = String(title || '').trim();
    var rule = matchRule(title);
    var steps = (rule ? rule.steps : FALLBACK).map(function (s) {
      return { title: s[0], pomos: s[1] };
    });

    // 标题里带「和 / 以及 / 、」时，认为包含两件事，补一条拆分提示
    if (/和|以及|、/.test(title) && steps.length > 1) {
      steps.splice(1, 0, { title: '把它拆成两部分，先只处理前一半', pomos: 1 });
    }

    // 标题长说明工作量不小，最后一步给多一点预算
    if (title.length > 18) {
      steps[steps.length - 1].pomos += 1;
    }

    return steps;
  }

  function localReview() {
    var stats = Store.todayStats();
    var state = Store.get();
    var active = Store.getActiveTask();

    var doneToday = state.tasks.filter(function (t) {
      return t.done && t.doneAt && Store.dayKey(t.doneAt) === Store.todayKey();
    });

    var pending = state.tasks.filter(function (t) { return !t.done; });

    var lines = [];
    lines.push('今天完成 ' + stats.pomos + ' 个番茄，专注 ' + stats.minutes + ' 分钟，结束 ' + stats.done + ' 项任务。');

    if (doneToday.length) {
      lines.push('清掉的：' + doneToday.map(function (t) { return '「' + t.title + '」'; }).join('、') + '。');
    } else if (stats.pomos === 0) {
      lines.push('还没开始也没关系，番茄钟的好处就是随时可以从一个 25 分钟重新开始。');
    } else {
      lines.push('专注时间花出去了，但没有任务被标记完成——如果它们其实做完了，记得勾掉。');
    }

    if (active) {
      lines.push('正在推进「' + active.title + '」，已投入 ' + active.donePomos + '/' + active.pomos + ' 个番茄。');
    }

    if (pending.length) {
      var next = active || pending[0];
      lines.push('还剩 ' + pending.length + ' 项没动。明天先拿「' + next.title + '」开刀，只做第一步，别先想整件事。');
    } else if (state.tasks.length) {
      lines.push('清单已经清空了，明天可以给自己加点更有挑战的。');
    }

    lines.push('\n（以上由本地规则生成。在设置里填入 API Key 后，会换成模型写的复盘。）');
    return lines.join('\n');
  }

  /* ---------- 对外接口 ---------- */

  var AI = {
    mode: function () {
      return Store.hasApiKey() ? 'remote' : 'local';
    },

    // 返回 { items: [{title, pomos}], source }
    breakdown: async function (title) {
      var fallback = localBreakdown(title);

      if (!Store.hasApiKey()) {
        return { items: fallback, source: 'local' };
      }

      var prompt = [
        '你是一个任务拆解助手。把用户给出的一件任务拆成 3～5 个可以立刻动手的小步骤。',
        '要求：',
        '1. 每个步骤必须是具体的动作，能在一个番茄（25 分钟）到两个番茄内推进；',
        '2. 步骤之间有先后顺序，第一条要足够小、能马上开始；',
        '3. 给每个步骤估算需要的番茄数（整数，1 或 2）；',
        '4. 只输出 JSON 数组，不要任何解释文字，格式：[{"title":"...","pomos":1}]'
      ].join('\n');

      try {
        var text = await chat([
          { role: 'system', content: prompt },
          { role: 'user', content: '任务：' + title }
        ], 0.5);

        var arr = parseJsonArray(text);
        if (!arr || !arr.length) throw new Error('返回格式看不懂');

        var items = arr.map(function (it) {
          var t = typeof it === 'string' ? it : (it.title || it.name || '');
          var p = Number(it && it.pomos) || 1;
          return { title: String(t).trim(), pomos: Math.max(1, Math.min(4, p)) };
        }).filter(function (it) { return it.title; });

        if (!items.length) throw new Error('返回内容为空');
        return { items: items, source: 'remote' };
      } catch (err) {
        console.warn('[ai] 远程拆解失败，回退本地规则', err);
        return { items: fallback, source: 'local', error: err.message };
      }
    },

    // 返回 { text, source }
    review: async function () {
      if (!Store.hasApiKey()) {
        return { text: localReview(), source: 'local' };
      }

      var stats = Store.todayStats();
      var state = Store.get();
      var pending = state.tasks.filter(function (t) { return !t.done; })
        .map(function (t) { return t.title + '（' + t.donePomos + '/' + t.pomos + ' 番茄）'; });
      var doneToday = state.tasks.filter(function (t) {
        return t.done && t.doneAt && Store.dayKey(t.doneAt) === Store.todayKey();
      }).map(function (t) { return t.title; });

      var ctx = [
        '今天完成番茄数：' + stats.pomos,
        '今日专注分钟：' + stats.minutes,
        '今日标记完成的任务：' + (doneToday.join('、') || '无'),
        '清单里未完成的任务：' + (pending.join('、') || '无')
      ].join('\n');

      try {
        var text = await chat([
          {
            role: 'system',
            content: '你是一个克制的效率教练。根据用户 today 的数据写一段 120 字以内的中文复盘：先给一句客观评价，再指出一个具体问题，最后给明天一条可以立刻执行的建议。不要用列表，不要客套话，不要编造数据。'
          },
          { role: 'user', content: ctx }
        ], 0.6);

        return { text: text, source: 'remote' };
      } catch (err) {
        console.warn('[ai] 远程复盘失败，回退本地模板', err);
        return { text: localReview(), source: 'local', error: err.message };
      }
    }
  };

  global.AI = AI;
})(window);
