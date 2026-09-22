/*
 * content.js — dashboard-only content script. Builds the task widget,
 * augments existing course cards, and wires the settings panel.
 * Depends on CdxState, CdxApi, CdxTheme (loaded before this file).
 */
(function () {
  'use strict';

  var S = window.CdxState;
  var Api = window.CdxApi;
  var Theme = window.CdxTheme;

  var state = {
    range: 'week',
    sort: 'priority', // 'priority' | 'due' | 'course'
    tasks: [], // normalized, merged canvas + custom
    overrides: {},
    courses: [], // { id, name, grade }
    settings: null,
    error: null,
    loaded: false,
    editingCustomId: null
  };

  var els = {};

  // ---------- Page guard ----------

  function isDashboardPage() {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    if (path !== '/' && path !== '/dashboard') return false;
    return true;
  }

  function findDashboardMount() {
    return document.getElementById('dashboard_header_container') ||
      document.getElementById('DashboardCard_Container') ||
      document.getElementById('dashboard-planner-header') ||
      document.getElementById('content');
  }

  // ---------- Widget skeleton ----------

  function el(tag, className, attrs) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    }
    return e;
  }

  function buildSkeleton() {
    var root = el('section', 'cdx-root cdx-widget', { 'aria-label': 'Task overview' });

    var header = el('header', 'cdx-widget__header');

    var tabs = el('div', 'cdx-tabs', { role: 'tablist', 'aria-label': 'Range' });
    ['day', 'week', 'month'].forEach(function (range) {
      var btn = el('button', 'cdx-tab', {
        role: 'tab',
        type: 'button',
        'aria-selected': String(range === state.range),
        'data-range': range,
        tabindex: range === state.range ? '0' : '-1'
      });
      btn.textContent = range.charAt(0).toUpperCase() + range.slice(1);
      btn.addEventListener('click', function () { setRange(range); });
      tabs.appendChild(btn);
    });
    header.appendChild(tabs);

    var actions = el('div', 'cdx-header-actions');

    var sortSelect = el('select', 'cdx-sort-select', { 'aria-label': 'Sort tasks by' });
    [
      { value: 'priority', label: 'Sort: Priority' },
      { value: 'due', label: 'Sort: Due date' },
      { value: 'course', label: 'Sort: Course' }
    ].forEach(function (opt) {
      var o = el('option', null, { value: opt.value });
      o.textContent = opt.label;
      sortSelect.appendChild(o);
    });
    sortSelect.value = state.sort;
    sortSelect.addEventListener('change', function () {
      state.sort = sortSelect.value;
      render();
    });
    actions.appendChild(sortSelect);

    var streakBtn = el('div', 'cdx-streak', { title: 'Current streak', 'aria-live': 'polite' });
    streakBtn.innerHTML = '<span class="cdx-streak__icon" aria-hidden="true">&#9679;</span><span class="cdx-streak__count">0</span>';
    actions.appendChild(streakBtn);

    var settingsBtn = el('button', 'cdx-settings-btn', { type: 'button', 'aria-label': 'Open dashboard settings' });
    settingsBtn.innerHTML = '<span aria-hidden="true">&#9881;</span>';
    settingsBtn.addEventListener('click', function () { els.settingsDialog.showModal(); });
    actions.appendChild(settingsBtn);
    header.appendChild(actions);

    root.appendChild(header);

    var errorBox = el('div', 'cdx-error', { role: 'alert', hidden: 'hidden' });
    root.appendChild(errorBox);

    var body = el('div', 'cdx-widget__body');

    var weekStrip = el('div', 'cdx-week-strip', { 'aria-label': 'Next 7 days' });
    for (var w = 0; w < 7; w++) {
      var dayEl = el('div', 'cdx-week-day');
      dayEl.innerHTML =
        '<span class="cdx-week-day__label"></span>' +
        '<span class="cdx-week-day__num"></span>' +
        '<span class="cdx-week-day__badge"></span>';
      weekStrip.appendChild(dayEl);
    }
    body.appendChild(weekStrip);

    var ringWrap = el('div', 'cdx-ring-wrap');
    ringWrap.innerHTML =
      '<svg class="cdx-ring" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Progress">' +
      '<circle class="cdx-ring__track" cx="32" cy="32" r="28"></circle>' +
      '<circle class="cdx-ring__fill" cx="32" cy="32" r="28"></circle>' +
      '</svg>' +
      '<div class="cdx-ring-label"><span class="cdx-skeleton-line" style="width:2.5em"></span></div>';
    body.appendChild(ringWrap);

    var list = el('ul', 'cdx-task-list', { 'aria-label': 'Tasks' });
    for (var i = 0; i < 3; i++) {
      var sk = el('li', 'cdx-task cdx-task--skeleton');
      sk.innerHTML = '<span class="cdx-skeleton-line" style="width:70%"></span>';
      list.appendChild(sk);
    }
    body.appendChild(list);

    var addForm = buildAddTaskForm();
    body.appendChild(addForm);

    root.appendChild(body);

    els.root = root;
    els.tabs = tabs;
    els.weekStrip = weekStrip;
    els.streakCount = streakBtn.querySelector('.cdx-streak__count');
    els.errorBox = errorBox;
    els.ringFill = ringWrap.querySelector('.cdx-ring__fill');
    els.ringLabel = ringWrap.querySelector('.cdx-ring-label');
    els.list = list;

    return root;
  }

  function buildAddTaskForm() {
    var form = el('form', 'cdx-add-task');
    var title = el('input', 'cdx-add-task__title', { type: 'text', placeholder: 'Add a task…', 'aria-label': 'New task title', maxlength: '200' });
    var course = el('select', 'cdx-add-task__course', { 'aria-label': 'Course (optional)' });
    course.appendChild(el('option', null, { value: '' }));
    var due = el('input', 'cdx-add-task__due', { type: 'date', 'aria-label': 'Due date (optional)' });
    var submit = el('button', 'cdx-btn cdx-btn--primary', { type: 'submit' });
    submit.textContent = 'Add';

    form.appendChild(title);
    form.appendChild(course);
    form.appendChild(due);
    form.appendChild(submit);

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var titleVal = title.value.trim();
      if (!titleVal) return;
      var courseId = course.value ? Number(course.value) : null;
      var courseName = null;
      if (courseId) {
        var c = state.courses.find(function (x) { return x.id === courseId; });
        courseName = c ? c.name : null;
      }
      var dueAt = due.value ? new Date(due.value + 'T23:59:00').toISOString() : null;
      await S.addCustomTask({ title: titleVal, courseId: courseId, courseName: courseName, dueAt: dueAt, done: false });
      title.value = '';
      due.value = '';
      await refreshFromLocalSources();
      render();
    });

    els.addTaskCourseSelect = course;
    return form;
  }

  function populateCourseSelect() {
    var select = els.addTaskCourseSelect;
    if (!select) return;
    var current = select.value;
    select.innerHTML = '';
    select.appendChild(el('option', null, { value: '' }));
    state.courses.forEach(function (c) {
      var opt = el('option', null, { value: String(c.id) });
      opt.textContent = c.name;
      select.appendChild(opt);
    });
    select.value = current;
  }

  // ---------- Data loading ----------

  async function loadFromCacheInstantly() {
    var plannerEntry = await S.getCache('planner');
    var missingEntry = await S.getCache('missing');
    var enrollEntry = await S.getCache('enrollments');
    state.overrides = await S.getOverrides();

    var canvasTasks = [];
    if (plannerEntry) canvasTasks = canvasTasks.concat(plannerEntry.data.map(S.normalizePlannerItem));
    if (missingEntry) {
      var seen = {};
      canvasTasks.forEach(function (t) { seen[t.plannableId] = true; });
      missingEntry.data.forEach(function (a) {
        if (!seen[a.id]) canvasTasks.push(S.normalizeMissingSubmission(a));
      });
    }
    var customTasks = (await S.getCustomTasks()).map(S.normalizeCustomTask);
    state.tasks = canvasTasks.concat(customTasks);

    if (enrollEntry) {
      state.courses = enrollEntry.data.map(mapEnrollmentToCourse);
    }

    state.loaded = plannerEntry != null || enrollEntry != null;
    return { plannerEntry: plannerEntry, missingEntry: missingEntry, enrollEntry: enrollEntry };
  }

  function mapEnrollmentToCourse(enr) {
    var score = enr.grades && typeof enr.grades.current_score === 'number' ? enr.grades.current_score : null;
    return {
      id: enr.course_id,
      name: (enr.course && (enr.course.name || enr.course.course_code)) || ('Course ' + enr.course_id),
      grade: score
    };
  }

  async function refreshFromLocalSources() {
    state.overrides = await S.getOverrides();
    var plannerEntry = await S.getCache('planner');
    var missingEntry = await S.getCache('missing');
    var canvasTasks = [];
    if (plannerEntry) canvasTasks = canvasTasks.concat(plannerEntry.data.map(S.normalizePlannerItem));
    if (missingEntry) {
      var seen = {};
      canvasTasks.forEach(function (t) { seen[t.plannableId] = true; });
      missingEntry.data.forEach(function (a) {
        if (!seen[a.id]) canvasTasks.push(S.normalizeMissingSubmission(a));
      });
    }
    var customTasks = (await S.getCustomTasks()).map(S.normalizeCustomTask);
    state.tasks = canvasTasks.concat(customTasks);
  }

  async function fetchFresh() {
    var results = await Promise.allSettled([
      Api.getPlannerItems(),
      Api.getMissingSubmissions(),
      Api.getEnrollmentsWithGrades()
    ]);

    var plannerRes = results[0];
    var missingRes = results[1];
    var enrollRes = results[2];

    var hardError = null;
    [plannerRes, enrollRes].forEach(function (r) {
      if (r.status === 'rejected') {
        var status = r.reason && r.reason.status;
        if (status === 401 || status === 403) hardError = { type: 'auth', status: status };
        else if (!hardError) hardError = { type: 'network' };
      }
    });

    if (plannerRes.status === 'fulfilled') await S.setCache('planner', plannerRes.value);
    if (missingRes.status === 'fulfilled') await S.setCache('missing', missingRes.value);
    if (enrollRes.status === 'fulfilled') await S.setCache('enrollments', enrollRes.value);

    state.error = hardError;

    await refreshFromLocalSources();
    var enrollEntry = await S.getCache('enrollments');
    if (enrollEntry) state.courses = enrollEntry.data.map(mapEnrollmentToCourse);

    // Record streak transitions based on freshly observed Canvas statuses.
    var statusMap = {};
    state.tasks.forEach(function (t) {
      statusMap[t.id] = S.deriveStatus(t, state.overrides, new Date());
    });
    await S.applyStatusesAndRecordStreak(statusMap);

    state.loaded = true;
  }

  // ---------- Rendering ----------

  function statusLabel(status) {
    return {
      'done': 'Done',
      'late': 'Late',
      'missing': 'Missing',
      'due-today': 'Due today',
      'upcoming': 'Upcoming',
      'no-date': 'No due date'
    }[status] || status;
  }

  function tasksInRange(tasks, range, now) {
    var bounds = S.rangeFor(range, now);
    return tasks.filter(function (t) {
      if (!t.dueAt) return false;
      var due = new Date(t.dueAt);
      return due >= bounds.start && due <= bounds.end;
    });
  }

  function formatDue(dueAt) {
    if (!dueAt) return '';
    var d = new Date(dueAt);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  async function toggleOverride(task, done) {
    if (task.source === 'custom') {
      await S.updateCustomTask(task.customId, { done: done });
    } else {
      await S.setOverride(task.plannableId, done);
    }
    if (done) {
      await S.recordCompletion(S.localDateKey(new Date()));
    }
    await refreshFromLocalSources();
    render();
  }

  function renderTaskItem(task, status) {
    var li = el('li', 'cdx-task cdx-task--' + status);
    var checkbox = el('input', 'cdx-task__checkbox', { type: 'checkbox' });
    checkbox.checked = status === 'done' || status === 'late';
    checkbox.disabled = task.source === 'canvas' && (task.submitted || task.graded);
    checkbox.setAttribute('aria-label', 'Mark "' + task.title + '" done');
    checkbox.addEventListener('change', function () { toggleOverride(task, checkbox.checked); });
    li.appendChild(checkbox);

    var main = el('div', 'cdx-task__main');
    var titleRow = el('div', 'cdx-task__title-row');
    var title = el('span', 'cdx-task__title');
    title.textContent = task.title;
    titleRow.appendChild(title);
    var pill = el('span', 'cdx-pill cdx-pill--' + status);
    pill.textContent = statusLabel(status);
    titleRow.appendChild(pill);
    main.appendChild(titleRow);

    var meta = el('div', 'cdx-task__meta');
    var bits = [];
    if (task.courseName) bits.push(task.courseName);
    if (task.dueAt) bits.push('Due ' + formatDue(task.dueAt));
    meta.textContent = bits.join(' · ');
    main.appendChild(meta);
    li.appendChild(main);

    if (task.source === 'custom') {
      var taskActions = el('div', 'cdx-task__actions');
      var editBtn = el('button', 'cdx-task__edit', { type: 'button', 'aria-label': 'Edit "' + task.title + '"' });
      editBtn.innerHTML = '&#9998;';
      editBtn.addEventListener('click', function () {
        state.editingCustomId = task.customId;
        render();
      });
      taskActions.appendChild(editBtn);

      var del = el('button', 'cdx-task__delete', { type: 'button', 'aria-label': 'Delete "' + task.title + '"' });
      del.innerHTML = '&times;';
      del.addEventListener('click', async function () {
        await S.deleteCustomTask(task.customId);
        await refreshFromLocalSources();
        render();
      });
      taskActions.appendChild(del);
      li.appendChild(taskActions);
    }

    return li;
  }

  function renderEditForm(task) {
    var li = el('li', 'cdx-task cdx-task--editing');
    var form = el('form', 'cdx-edit-task');

    var title = el('input', 'cdx-edit-task__title', { type: 'text', 'aria-label': 'Title' });
    title.value = task.title;

    var course = el('select', 'cdx-edit-task__course', { 'aria-label': 'Course (optional)' });
    course.appendChild(el('option', null, { value: '' }));
    state.courses.forEach(function (c) {
      var opt = el('option', null, { value: String(c.id) });
      opt.textContent = c.name;
      if (task.courseId === c.id) opt.selected = true;
      course.appendChild(opt);
    });

    var due = el('input', 'cdx-edit-task__due', { type: 'date', 'aria-label': 'Due date (optional)' });
    if (task.dueAt) due.value = new Date(task.dueAt).toISOString().slice(0, 10);

    var save = el('button', 'cdx-btn cdx-btn--primary', { type: 'submit' });
    save.textContent = 'Save';
    var cancel = el('button', 'cdx-btn', { type: 'button' });
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () {
      state.editingCustomId = null;
      render();
    });

    form.appendChild(title);
    form.appendChild(course);
    form.appendChild(due);
    form.appendChild(save);
    form.appendChild(cancel);

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var titleVal = title.value.trim();
      if (!titleVal) return;
      var courseId = course.value ? Number(course.value) : null;
      var c = state.courses.find(function (x) { return x.id === courseId; });
      var dueAt = due.value ? new Date(due.value + 'T23:59:00').toISOString() : null;
      await S.updateCustomTask(task.customId, {
        title: titleVal,
        courseId: courseId,
        courseName: c ? c.name : null,
        dueAt: dueAt
      });
      state.editingCustomId = null;
      await refreshFromLocalSources();
      render();
    });

    li.appendChild(form);
    return li;
  }

  function render() {
    var now = new Date();
    var inRange = tasksInRange(state.tasks, state.range, now);

    inRange.sort(function (a, b) { return new Date(a.dueAt) - new Date(b.dueAt); });

    var statusOrder = { 'missing': 0, 'due-today': 1, 'late': 2, 'upcoming': 3, 'done': 4 };
    var withStatus = inRange.map(function (t) {
      return { task: t, status: S.deriveStatus(t, state.overrides, now) };
    }).filter(function (x) { return x.status !== 'no-date'; });

    if (state.sort === 'due') {
      withStatus.sort(function (a, b) { return new Date(a.task.dueAt) - new Date(b.task.dueAt); });
    } else if (state.sort === 'course') {
      withStatus.sort(function (a, b) {
        var an = a.task.courseName || '';
        var bn = b.task.courseName || '';
        if (an !== bn) return an.localeCompare(bn);
        return new Date(a.task.dueAt) - new Date(b.task.dueAt);
      });
    } else {
      withStatus.sort(function (a, b) {
        var so = (statusOrder[a.status] - statusOrder[b.status]);
        if (so !== 0) return so;
        return new Date(a.task.dueAt) - new Date(b.task.dueAt);
      });
    }

    var total = withStatus.length;
    var done = withStatus.filter(function (x) { return S.isCompletedStatus(x.status); }).length;

    // Ring
    var circumference = 2 * Math.PI * 28;
    els.ringFill.style.strokeDasharray = String(circumference);
    if (total === 0) {
      els.ringFill.style.strokeDashoffset = String(circumference);
      els.ringLabel.textContent = '0/0';
      els.ringLabel.classList.add('is-empty');
    } else {
      var fraction = done / total;
      els.ringFill.style.strokeDashoffset = String(circumference * (1 - fraction));
      els.ringLabel.textContent = done + '/' + total;
      els.ringLabel.classList.remove('is-empty');
    }

    // Task list
    els.list.innerHTML = '';
    if (withStatus.length === 0) {
      var empty = el('li', 'cdx-task cdx-task--empty');
      empty.textContent = 'Nothing due in this range.';
      els.list.appendChild(empty);
    } else {
      withStatus.forEach(function (x) {
        if (x.task.source === 'custom' && x.task.customId === state.editingCustomId) {
          els.list.appendChild(renderEditForm(x.task));
        } else {
          els.list.appendChild(renderTaskItem(x.task, x.status));
        }
      });
    }

    // Tabs
    Array.prototype.forEach.call(els.tabs.querySelectorAll('.cdx-tab'), function (btn) {
      var active = btn.getAttribute('data-range') === state.range;
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    });

    // Error box
    if (state.error) {
      els.errorBox.hidden = false;
      if (state.error.type === 'auth') {
        els.errorBox.textContent = 'Your Canvas session has expired. Reload the page and sign in again.';
      } else {
        els.errorBox.textContent = state.loaded
          ? 'Could not reach Canvas — showing cached data.'
          : 'Could not load tasks from Canvas.';
      }
    } else {
      els.errorBox.hidden = true;
      els.errorBox.textContent = '';
    }

    populateCourseSelect();
    renderStreak();
    renderWeekStrip();
    renderCourseCards(withStatusForCourses());
  }

  function renderWeekStrip() {
    var now = new Date();
    var todayStart = S.startOfDay(now);
    var dayEls = els.weekStrip.querySelectorAll('.cdx-week-day');
    for (var i = 0; i < dayEls.length; i++) {
      var d = new Date(todayStart);
      d.setDate(d.getDate() + i);
      var dayEnd = S.endOfDay(d);
      var count = 0;
      var hasMissing = false;
      state.tasks.forEach(function (t) {
        if (!t.dueAt) return;
        var due = new Date(t.dueAt);
        if (due >= d && due <= dayEnd) {
          count++;
          if (S.deriveStatus(t, state.overrides, now) === 'missing') hasMissing = true;
        }
      });
      var dayEl = dayEls[i];
      dayEl.querySelector('.cdx-week-day__label').textContent = d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
      dayEl.querySelector('.cdx-week-day__num').textContent = String(d.getDate());
      dayEl.querySelector('.cdx-week-day__badge').textContent = count > 0 ? String(count) : '';
      dayEl.classList.toggle('is-today', i === 0);
      dayEl.classList.toggle('has-tasks', count > 0);
      dayEl.classList.toggle('has-missing', hasMissing);
    }
  }

  function withStatusForCourses() {
    var now = new Date();
    return state.tasks.map(function (t) {
      return { task: t, status: S.deriveStatus(t, state.overrides, now) };
    });
  }

  async function renderStreak() {
    var history = await S.getStreakHistory();
    var streak = S.computeStreak(history, new Date());
    if (els.streakCount) els.streakCount.textContent = String(streak);
  }

  function setRange(range) {
    state.range = range;
    render();
  }

  // ---------- Course card augmentation ----------

  function findCourseCards() {
    return Array.prototype.slice.call(document.querySelectorAll('.ic-DashboardCard'));
  }

  function courseIdFromCard(card) {
    var attr = card.getAttribute('data-course-id');
    if (attr) return Number(attr);
    var link = card.querySelector('a[href*="/courses/"]');
    if (link) {
      var m = link.getAttribute('href').match(/\/courses\/(\d+)/);
      if (m) return Number(m[1]);
    }
    return null;
  }

  function renderCourseCards(taskStatuses) {
    var weekBounds = S.rangeFor('week', new Date());
    var cards = findCourseCards();
    cards.forEach(function (card) {
      var courseId = courseIdFromCard(card);
      if (!courseId) return;

      // Thin colored top border instead of the banner image.
      var hero = card.querySelector('.ic-DashboardCard__header_hero, .ic-DashboardCard__header_image');
      if (hero) {
        var bg = getComputedStyle(hero).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          card.style.setProperty('--cdx-course-color', bg);
        }
      }
      card.classList.add('cdx-course-card');

      var course = state.courses.find(function (c) { return c.id === courseId; });
      var gradeText = course && typeof course.grade === 'number' && !isNaN(course.grade)
        ? Math.round(course.grade) + '%'
        : 'N/A';

      var dueThisWeek = taskStatuses.filter(function (x) {
        if (x.task.courseId !== courseId || !x.task.dueAt) return false;
        var due = new Date(x.task.dueAt);
        return due >= weekBounds.start && due <= weekBounds.end;
      }).length;

      var missing = taskStatuses.filter(function (x) {
        return x.task.courseId === courseId && x.status === 'missing';
      }).length;

      var statsEl = card.querySelector('.cdx-course-stats');
      if (!statsEl) {
        statsEl = el('div', 'cdx-course-stats');
        var content = card.querySelector('.ic-DashboardCard__header_content') || card.querySelector('.ic-DashboardCard__header');
        if (content && content.parentNode) {
          content.parentNode.insertBefore(statsEl, content.nextSibling);
        } else {
          card.appendChild(statsEl);
        }
      }
      statsEl.innerHTML =
        '<span class="cdx-course-stat" title="Current grade">' + gradeText + '</span>' +
        '<span class="cdx-course-stat" title="Due this week">' + dueThisWeek + ' due</span>' +
        '<span class="cdx-course-stat cdx-course-stat--missing" title="Missing">' + missing + ' missing</span>';
    });
  }

  function observeCourseCards() {
    var container = document.getElementById('DashboardCard_Container') || document.body;
    var timer = null;
    var observer = new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(function () { render(); }, 200);
    });
    observer.observe(container, { childList: true, subtree: true });
  }

  // ---------- Settings wiring ----------

  async function initSettings() {
    state.settings = await S.getSettings();
    Theme.applySettings(state.settings);

    els.settingsDialog = Theme.buildSettingsDialog(
      function () { return state.settings; },
      async function (patch) {
        state.settings = await S.setSettings(patch);
        Theme.applySettings(state.settings);
      }
    );
    document.body.appendChild(els.settingsDialog);

    Theme.watchSystemMode(function () {
      if (state.settings && state.settings.mode === 'follow-system') {
        Theme.applySettings(state.settings);
      }
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'sync' && changes.cdx_settings) {
        state.settings = Object.assign({}, S.DEFAULT_SETTINGS, changes.cdx_settings.newValue || {});
        Theme.applySettings(state.settings);
      }
    });
  }

  // ---------- Init ----------

  async function init() {
    if (!isDashboardPage()) return;

    await initSettings();

    var mount = findDashboardMount();
    var widget = buildSkeleton();
    if (mount && mount.parentNode) {
      mount.parentNode.insertBefore(widget, mount);
    } else {
      document.body.insertBefore(widget, document.body.firstChild);
    }

    var cacheEntries = await loadFromCacheInstantly();
    render();

    var plannerStale = !S.isFresh(cacheEntries.plannerEntry);
    var enrollStale = !S.isFresh(cacheEntries.enrollEntry);
    var missingStale = !S.isFresh(cacheEntries.missingEntry);

    if (plannerStale || enrollStale || missingStale || !state.loaded) {
      try {
        await fetchFresh();
      } catch (e) {
        state.error = { type: 'network' };
      }
      render();
    }

    observeCourseCards();
    // Course cards may render asynchronously after this script runs.
    setTimeout(render, 800);
    setTimeout(render, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
