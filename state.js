/*
 * state.js — local storage, caching, task-status derivation, streak tracking.
 * Everything here is local-only (chrome.storage.local / chrome.storage.sync).
 * Nothing is ever written back to Canvas.
 */
(function (global) {
  'use strict';

  var KEYS = {
    CACHE_PLANNER: 'cdx_cache_planner',
    CACHE_MISSING: 'cdx_cache_missing',
    CACHE_ENROLLMENTS: 'cdx_cache_enrollments',
    OVERRIDES: 'cdx_manual_overrides',
    CUSTOM_TASKS: 'cdx_custom_tasks',
    STREAK: 'cdx_streak_history',
    LAST_STATUSES: 'cdx_last_statuses'
  };

  var SETTINGS_KEY = 'cdx_settings';
  var CACHE_TTL_MS = 5 * 60 * 1000;

  var DEFAULT_SETTINGS = {
    mode: 'follow-system', // 'light' | 'dark' | 'follow-system'
    accent: '#c0392b',
    accentPreset: 'crimson',
    background: 'image', // 'solid' | 'tint' | 'none' | 'image'
    font: 'serif', // 'system' | 'serif' | 'mono'
    density: 'comfortable', // 'compact' | 'comfortable'
    radius: 'soft', // 'sharp' | 'soft' | 'round'
    showStreak: true,
    showRing: true,
    showCourseImages: true
  };

  function localGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, resolve);
    });
  }
  function localSet(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, resolve);
    });
  }
  function syncGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.sync.get(keys, resolve);
    });
  }
  function syncSet(obj) {
    return new Promise(function (resolve) {
      chrome.storage.sync.set(obj, resolve);
    });
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function localDateKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function startOfDay(d) {
    var x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function endOfDay(d) {
    var x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }
  function startOfWeek(d) {
    var x = startOfDay(d);
    var day = x.getDay(); // 0 Sun .. 6 Sat
    var diff = (day === 0 ? -6 : 1 - day); // Monday start
    x.setDate(x.getDate() + diff);
    return x;
  }
  function endOfWeek(d) {
    var s = startOfWeek(d);
    var x = new Date(s);
    x.setDate(x.getDate() + 6);
    return endOfDay(x);
  }
  function startOfMonth(d) {
    var x = startOfDay(d);
    x.setDate(1);
    return x;
  }
  function endOfMonth(d) {
    var x = startOfMonth(d);
    x.setMonth(x.getMonth() + 1);
    x.setDate(0);
    return endOfDay(x);
  }
  function isSameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }

  function rangeFor(range, now) {
    now = now || new Date();
    if (range === 'day') return { start: startOfDay(now), end: endOfDay(now) };
    if (range === 'month') return { start: startOfMonth(now), end: endOfMonth(now) };
    return { start: startOfWeek(now), end: endOfWeek(now) };
  }

  // ---- Cache ----

  function cacheKeyFor(name) {
    return KEYS['CACHE_' + name.toUpperCase()];
  }

  async function getCache(name) {
    var key = cacheKeyFor(name);
    var res = await localGet([key]);
    var entry = res[key];
    if (!entry) return null;
    return entry; // { data, storedAt }
  }

  async function setCache(name, data) {
    var key = cacheKeyFor(name);
    var entry = { data: data, storedAt: Date.now() };
    var obj = {};
    obj[key] = entry;
    await localSet(obj);
    return entry;
  }

  function isFresh(entry) {
    return !!entry && (Date.now() - entry.storedAt) < CACHE_TTL_MS;
  }

  // ---- Manual overrides (keyed by plannable id) ----

  async function getOverrides() {
    var res = await localGet([KEYS.OVERRIDES]);
    return res[KEYS.OVERRIDES] || {};
  }

  async function setOverride(plannableId, done) {
    var overrides = await getOverrides();
    overrides[String(plannableId)] = { done: !!done, updatedAt: new Date().toISOString() };
    var obj = {};
    obj[KEYS.OVERRIDES] = overrides;
    await localSet(obj);
    return overrides;
  }

  // ---- Custom tasks ----

  function uuid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function getCustomTasks() {
    var res = await localGet([KEYS.CUSTOM_TASKS]);
    return res[KEYS.CUSTOM_TASKS] || [];
  }

  async function addCustomTask(task) {
    var tasks = await getCustomTasks();
    var item = {
      id: uuid(),
      title: task.title,
      courseId: task.courseId || null,
      courseName: task.courseName || null,
      dueAt: task.dueAt || null,
      done: !!task.done,
      createdAt: new Date().toISOString()
    };
    tasks.push(item);
    var obj = {};
    obj[KEYS.CUSTOM_TASKS] = tasks;
    await localSet(obj);
    return item;
  }

  async function updateCustomTask(id, patch) {
    var tasks = await getCustomTasks();
    var idx = tasks.findIndex(function (t) { return t.id === id; });
    if (idx === -1) return null;
    tasks[idx] = Object.assign({}, tasks[idx], patch);
    var obj = {};
    obj[KEYS.CUSTOM_TASKS] = tasks;
    await localSet(obj);
    return tasks[idx];
  }

  async function deleteCustomTask(id) {
    var tasks = await getCustomTasks();
    tasks = tasks.filter(function (t) { return t.id !== id; });
    var obj = {};
    obj[KEYS.CUSTOM_TASKS] = tasks;
    await localSet(obj);
  }

  // ---- Streak ----

  async function getStreakHistory() {
    var res = await localGet([KEYS.STREAK]);
    return res[KEYS.STREAK] || { dates: {} };
  }

  async function recordCompletion(dateKey) {
    var history = await getStreakHistory();
    if (!history.dates[dateKey]) {
      history.dates[dateKey] = true;
      var obj = {};
      obj[KEYS.STREAK] = history;
      await localSet(obj);
    }
    return history;
  }

  function computeStreak(history, now) {
    now = now || new Date();
    var dates = (history && history.dates) || {};
    var todayKey = localDateKey(now);
    var cursor = startOfDay(now);
    if (!dates[todayKey]) {
      cursor.setDate(cursor.getDate() - 1);
    }
    var streak = 0;
    while (dates[localDateKey(cursor)]) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  // ---- Status transition tracking (drives streak from Canvas-observed completions) ----

  async function getLastStatuses() {
    var res = await localGet([KEYS.LAST_STATUSES]);
    return res[KEYS.LAST_STATUSES] || {};
  }

  async function applyStatusesAndRecordStreak(taskIdToStatus) {
    var last = await getLastStatuses();
    var completedNow = false;
    Object.keys(taskIdToStatus).forEach(function (id) {
      var status = taskIdToStatus[id];
      var wasDone = last[id] === 'done' || last[id] === 'late';
      var isDone = status === 'done' || status === 'late';
      if (isDone && !wasDone) completedNow = true;
    });
    var obj = {};
    obj[KEYS.LAST_STATUSES] = Object.assign({}, last, taskIdToStatus);
    await localSet(obj);
    if (completedNow) {
      await recordCompletion(localDateKey(new Date()));
    }
  }

  // ---- Settings (sync) ----

  async function getSettings() {
    var res = await syncGet([SETTINGS_KEY]);
    return Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY] || {});
  }

  async function setSettings(patch) {
    var current = await getSettings();
    var next = Object.assign({}, current, patch);
    var obj = {};
    obj[SETTINGS_KEY] = next;
    await syncSet(obj);
    return next;
  }

  // ---- Task normalization + status derivation ----

  function normalizePlannerItem(item) {
    var plannable = item.plannable || {};
    var subs = item.submissions || {};
    var dueAt = plannable.due_at || item.plannable_date || null;
    return {
      id: 'canvas-' + item.plannable_id,
      source: 'canvas',
      plannableId: item.plannable_id,
      plannableType: item.plannable_type,
      title: plannable.title || plannable.name || 'Untitled',
      courseId: item.course_id || null,
      courseName: item.context_name || null,
      dueAt: dueAt,
      submitted: !!subs.submitted,
      graded: !!subs.graded,
      late: !!subs.late,
      missingFlag: !!subs.missing,
      htmlUrl: item.html_url || null
    };
  }

  function normalizeMissingSubmission(assignment) {
    return {
      id: 'canvas-' + assignment.id,
      source: 'canvas',
      plannableId: assignment.id,
      plannableType: 'assignment',
      title: assignment.name || 'Untitled',
      courseId: assignment.course_id || null,
      courseName: (assignment.course && assignment.course.name) || null,
      dueAt: assignment.due_at || null,
      submitted: false,
      graded: false,
      late: false,
      missingFlag: true,
      htmlUrl: assignment.html_url || null
    };
  }

  function normalizeCustomTask(task) {
    return {
      id: 'custom-' + task.id,
      customId: task.id,
      source: 'custom',
      plannableId: null,
      plannableType: 'custom',
      title: task.title,
      courseId: task.courseId,
      courseName: task.courseName,
      dueAt: task.dueAt,
      submitted: false,
      graded: false,
      late: false,
      missingFlag: false,
      manualDone: !!task.done,
      htmlUrl: null
    };
  }

  // Status order: done -> missing -> late -> due-today -> upcoming (late is a
  // submitted-but-after-due variant folded into the "submitted" branch; see
  // README notes shipped with the extension for the exact reasoning).
  function deriveStatus(task, overrides, now) {
    now = now || new Date();
    if (task.source === 'custom') {
      if (task.manualDone) return 'done';
    } else {
      if (task.submitted) return task.late ? 'late' : 'done';
      if (task.graded) return 'done';
      var override = overrides[String(task.plannableId)];
      if (override && override.done) return 'done';
    }
    if (!task.dueAt) return 'no-date';
    var due = new Date(task.dueAt);
    if (due.getTime() < now.getTime()) return 'missing';
    if (isSameLocalDay(due, now)) return 'due-today';
    return 'upcoming';
  }

  function isCompletedStatus(status) {
    return status === 'done' || status === 'late';
  }

  global.CdxState = {
    KEYS: KEYS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    CACHE_TTL_MS: CACHE_TTL_MS,
    localDateKey: localDateKey,
    startOfDay: startOfDay,
    endOfDay: endOfDay,
    startOfWeek: startOfWeek,
    endOfWeek: endOfWeek,
    startOfMonth: startOfMonth,
    endOfMonth: endOfMonth,
    isSameLocalDay: isSameLocalDay,
    rangeFor: rangeFor,
    getCache: getCache,
    setCache: setCache,
    isFresh: isFresh,
    getOverrides: getOverrides,
    setOverride: setOverride,
    getCustomTasks: getCustomTasks,
    addCustomTask: addCustomTask,
    updateCustomTask: updateCustomTask,
    deleteCustomTask: deleteCustomTask,
    getStreakHistory: getStreakHistory,
    recordCompletion: recordCompletion,
    computeStreak: computeStreak,
    applyStatusesAndRecordStreak: applyStatusesAndRecordStreak,
    getSettings: getSettings,
    setSettings: setSettings,
    normalizePlannerItem: normalizePlannerItem,
    normalizeMissingSubmission: normalizeMissingSubmission,
    normalizeCustomTask: normalizeCustomTask,
    deriveStatus: deriveStatus,
    isCompletedStatus: isCompletedStatus
  };
})(window);
