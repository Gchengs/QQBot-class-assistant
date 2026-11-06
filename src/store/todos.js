import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { today, diffDays } from '../utils/date.js';
import { migrate, SCHEMA_VERSION } from './schema.js';

const FILE = () => path.join(config.dataDir, 'todos.json');

let cache = null;

function emptyState() {
  return { version: SCHEMA_VERSION, todos: [] };
}

function load() {
  if (cache) return cache;
  const file = FILE();
  if (!fs.existsSync(file)) {
    cache = emptyState();
    return cache;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.error(`读取待办库失败，将以空库启动：${err.message}`);
    cache = emptyState();
    return cache;
  }

  // 版本问题故意不放进上面的 catch：读不懂就启动失败，别让空库把原文件覆盖掉
  const data = migrate(parsed, file);
  cache = { version: SCHEMA_VERSION, todos: Array.isArray(data.todos) ? data.todos : [] };
  return cache;
}

function save() {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function normalizeTitle(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[。，,.\s]/g, '')
    .toLowerCase();
}

export function addTodo({
  group,
  title,
  owner = '',
  ownerInferred = false,
  ownerOpenid = '',
  due = null,
  sourceMsgId = '',
  sourceText = '',
  source = 'auto',
  dueTime = null,
  dueStart = null,
  timeState = null,
}) {
  const state = load();
  const nTitle = normalizeTitle(title);
  const dup = state.todos.find(
    (t) =>
      t.group === group &&
      t.status === 'open' &&
      normalizeTitle(t.title) === nTitle &&
      (t.due ?? null) === (due ?? null) &&
      (t.due_time ?? null) === (dueTime ?? null)
  );
  if (dup) return { todo: dup, duplicated: true };

  const todo = {
    id: crypto.randomUUID(),
    group,
    title: String(title).trim(),
    owner: owner || '',
    // true = 这个负责人是系统按事项性质猜的，不是通知里写的。
    // 留个标记，就是为了以后能一眼分辨「他真负责」和「系统以为他负责」。
    owner_inferred: Boolean(ownerInferred),
    owner_openid: ownerOpenid || '',
    due: due || null,
    // 区间任务（「11月9日～11月27日内完成」）的开始日。截止日仍存在 due
    due_start: dueStart && due && dueStart !== due ? dueStart : null,
    due_time: dueTime || null,
    // dated = 有截止日；pending = 日期待定；ongoing = 无期限
    time_state: due ? 'dated' : timeState || 'pending',
    // 已经推送过几次。只对没有截止日的项计数，到上限就不再出现
    shown: 0,
    status: 'open',
    source,
    source_msg_id: sourceMsgId || '',
    source_text: sourceText ? String(sourceText).slice(0, 200) : '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  state.todos.push(todo);
  save();
  return { todo, duplicated: false };
}

/**
 * 这条待办还能不能出现在推送里。
 *
 * 有截止日的永远能出现（过期后由自动销项归档）；
 * 没有截止日的按次数衰减：日期待定 3 次、无期限 2 次，超了就静默。
 * 不这么做的话，一条「看 CAD 回放」会跟着周报推一整学期，人就会开始无视整个周报。
 */
export function isDisplayable(todo) {
  if (!todo) return false;
  if (todo.due) return true;
  const limit =
    todo.time_state === 'ongoing' ? config.ongoingShowLimit : config.pendingShowLimit;
  if (!Number.isFinite(limit) || limit <= 0) return true;
  return (todo.shown || 0) < limit;
}

/** 推送后记一次数。只统计没有截止日的项——有截止日的靠日期自然退出，不需要配额 */
export function bumpShown(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const state = load();
  const set = new Set(ids);
  const now = new Date().toISOString();
  let n = 0;
  for (const todo of state.todos) {
    if (!set.has(todo.id)) continue;
    if (todo.due) continue;
    todo.shown = (todo.shown || 0) + 1;
    todo.last_shown_at = now;
    todo.updated_at = now;
    n += 1;
  }
  if (n) save();
  return n;
}

export function listTodos(group, { status = 'open' } = {}) {
  const state = load();
  return state.todos
    .filter((t) => t.group === group)
    .filter((t) => (status === 'all' ? true : t.status === status))
    .sort((a, b) => {
      if (!a.due && !b.due) return a.created_at.localeCompare(b.created_at);
      if (!a.due) return 1;
      if (!b.due) return -1;
      if (a.due !== b.due) return a.due.localeCompare(b.due);
      return (a.due_time ?? '99:99').localeCompare(b.due_time ?? '99:99');
    });
}

/**
 * 只返回「还能正常安排」的待办：未完成 + 未逾期。
 * 逾期的按用户要求不再展示，但仍保留在库里，可以用 list --all 查。
 */
export function listActive(group) {
  const t = today();
  return listTodos(group, { status: 'open' }).filter((x) => !x.due || x.due >= t);
}

export function getTodo(id) {
  return load().todos.find((t) => t.id === id) || null;
}

export function updateTodo(id, patch) {
  const state = load();
  const todo = state.todos.find((t) => t.id === id);
  if (!todo) return null;
  Object.assign(todo, patch, { updated_at: new Date().toISOString() });
  save();
  return todo;
}

export function findByKeyword(group, keyword) {
  const state = load();
  const k = normalizeTitle(keyword);
  if (!k) return [];
  return state.todos.filter(
    (t) => t.group === group && t.status === 'open' && normalizeTitle(t.title).includes(k)
  );
}

/**
 * 把一个群名下的待办整体迁移到另一个群名。
 * 用途：还没拿到群 openid 时先存在占位群里，拿到后一次性搬过去。
 */
export function moveGroup(from, to) {
  if (!from || !to || from === to) return 0;
  const state = load();
  let n = 0;
  for (const t of state.todos) {
    if (t.group === from) {
      t.group = to;
      t.updated_at = new Date().toISOString();
      n += 1;
    }
  }
  if (n) save();
  return n;
}

export function closeExpiredNoDue(days = 30) {
  const state = load();
  const cutoff = today();
  let changed = 0;
  for (const t of state.todos) {
    if (t.status !== 'open') continue;
    if (t.due) continue;
    const age = diffDays(today(), t.created_at.slice(0, 10));
    if (age >= days) {
      t.status = 'expired';
      t.updated_at = new Date().toISOString();
      changed += 1;
    }
  }
  if (changed) save();
  return changed;
}

/**
 * 自动销项：过了截止日的还没人销，就归档成 expired。
 * 每天定时跑一次，服务启动时也跑一次（防止停机期间积压一大堆）。
 * 想找回某条，可以 #恢复 关键词。
 */
export function autoCloseOverdue() {
  const t = today();
  const state = load();
  const now = new Date().toISOString();
  let changed = 0;
  for (const todo of state.todos) {
    if (todo.status !== 'open') continue;
    if (!todo.due || todo.due >= t) continue;
    todo.status = 'expired';
    todo.auto_closed = true;
    todo.closed_at = now;
    todo.updated_at = now;
    changed += 1;
  }
  if (changed) save();
  return changed;
}

/** 把自动过期的项撤回成 open（手工救回用）。截止日已过的顺延到今天，否则还是会被过滤掉 */
export function reopenByKeyword(group, keyword) {
  const state = load();
  const k = normalizeTitle(keyword);
  if (!k) return [];
  const t = today();
  const now = new Date().toISOString();
  const hits = state.todos.filter(
    (t) =>
      t.group === group &&
      t.status === 'expired' &&
      normalizeTitle(t.title).includes(k)
  );
  for (const todo of hits) {
    todo.status = 'open';
    delete todo.auto_closed;
    delete todo.closed_at;
    if (todo.due && todo.due < t) {
      todo.due = t;
      todo.due_time = null;
    }
    todo.updated_at = now;
  }
  if (hits.length) save();
  return hits;
}

export function groupStats(group) {
  const open = listTodos(group, { status: 'open' });
  const t = today();
  return {
    total: open.length,
    overdue: open.filter((x) => x.due && x.due < t).length,
    dueToday: open.filter((x) => x.due === t).length,
    dueTomorrow: open.filter((x) => x.due && diffDays(t, x.due) === 1).length,
  };
}

export function knownGroups() {
  const state = load();
  return [...new Set(state.todos.map((t) => t.group))];
}
