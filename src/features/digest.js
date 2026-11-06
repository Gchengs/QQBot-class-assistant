import { config } from '../config.js';
import { listActive, listTodos, isDisplayable, bumpShown } from '../store/todos.js';
import { renderDigest, renderWeekly } from './render.js';
import { sendLongGroupMessage, sendGroupMessage } from '../qq/api.js';
import { today, diffDays, weekRange, addDays } from '../utils/date.js';
import { lastWeeklyDate, markWeeklySent } from '../store/pushstate.js';
import { log } from '../logger.js';

/**
 * 周报单条上限。QQ 主动消息每群每月只有 4 条左右，
 * 一旦被拆成多条，一次周报就吃掉好几条配额，所以这里强制单条、超长截断。
 */
const WEEKLY_MAX_CHARS = 1200;

/**
 * 每日 18:00 推送。
 * all    —— 推送全部进行中待办（默认，对应「推近期所有待办」的需求）
 * urgent —— 只推逾期 / 今天 / 明天到期的，没有就不发
 */
export async function pushDigest(group) {
  const all = listActive(group);
  if (!all.length) return { sent: false, reason: '没有任何进行中的待办' };

  let target = all;
  if (config.digestMode === 'urgent') {
    const t = today();
    target = all.filter((x) => x.due && diffDays(t, x.due) <= 1);
    if (!target.length) {
      return { sent: false, reason: 'urgent 模式下没有临期待办，跳过' };
    }
  }

  const text = renderDigest(target, group);
  if (!text) return { sent: false, reason: '渲染结果为空' };

  const sent = await sendLongGroupMessage(group, text);
  log.info(`日报已推送群 ${group}：${target.length} 项，分 ${sent.length} 条`);
  return { sent: true, count: target.length, chunks: sent.length };
}

/**
 * 把待办分进周报的几个块。
 *
 * 区间任务（「11月9日～11月27日内完成」）两头都要提醒：
 * 开始日决定它从哪一期开始出现，截止日决定它什么时候退出。
 * 只看截止日的话，开始那一周没有任何提示；只看开始日的话，中途就漏了。
 *
 * 已经开始、还没截止的单独成「进行中」块——混在「本周剩余」里
 * 会让人误以为这周就要交。
 */
export function pickWeeklyBuckets(all, t = today()) {
  const { end } = weekRange(t);
  const nextEnd = addDays(end, 7);

  const remindAt = (x) => (x.due_start && x.due_start >= t ? x.due_start : x.due);
  const running = (x) => Boolean(x.due_start && x.due_start < t && x.due >= t);

  return {
    end,
    nextEnd,
    overdue: all.filter((x) => x.due && x.due < t),
    inProgress: all.filter((x) => x.due && x.due >= t && running(x)),
    thisWeek: all.filter(
      (x) => x.due && x.due >= t && !running(x) && remindAt(x) <= end
    ),
    nextWeek: all.filter(
      (x) =>
        x.due && x.due >= t && !running(x) && remindAt(x) > end && remindAt(x) <= nextEnd
    ),
    // 两周以后的事。不列的话，11 月 21 号的期中考试在 11 月 7 日的周报里完全看不到，
    // 用户只会觉得「周报不全」——其实是被两周的窗口挡住了。
    later: all
      .filter((x) => x.due && x.due >= t && !running(x) && remindAt(x) > nextEnd)
      .sort((a, b) => String(remindAt(a)).localeCompare(String(remindAt(b)))),
    pending: all.filter((x) => !x.due && x.time_state !== 'ongoing'),
    ongoing: all.filter((x) => !x.due && x.time_state === 'ongoing'),
  };
}

/**
 * 周六早上 8 点的周报。
 * 覆盖本周一到本周日，逾期项单列在前。
 * 走 sendGroupMessage 单条发送，不调 sendLongGroupMessage——
 * 后者最多拆 3 条，每条都是一个独立的主动消息，会成倍消耗每月配额。
 *
 * 没有截止日的待办按次数衰减：日期待定 3 次、无期限 2 次，之后不再出现在推送里。
 * 否则一条「看 CAD 回放」会跟着周报推一整个学期，人会开始无视整份周报。
 */
export async function pushWeekly(group, { force = false } = {}) {
  const all = listTodos(group, { status: 'open' }).filter(isDisplayable);
  const t = today();

  // 同一自然周只推一次。月中手动补发过、或验证时发过一条，
  // 本周六就自动跳过，否则这个月会变成 5 条，第 5 条必然被平台拒。
  if (!force) {
    const last = lastWeeklyDate(group);
    if (last && weekRange(last).start === weekRange(t).start) {
      log.info(
        `周报 ${group}: 本周已于 ${last} 推送过，跳过（保住每月 4 条配额）`
      );
      return { sent: false, reason: `本周已推送过（${last}）`, skipped: true };
    }
  }

  const {
    overdue,
    inProgress,
    thisWeek,
    nextWeek,
    later,
    pending,
    ongoing,
  } = pickWeeklyBuckets(all, t);

  if (
    !overdue.length &&
    !inProgress.length &&
    !thisWeek.length &&
    !nextWeek.length &&
    !later.length &&
    !pending.length &&
    !ongoing.length
  ) {
    log.info(`周报 ${group}: 没有要推的内容，跳过（不消耗主动消息配额）`);
    return { sent: false, reason: '没有可推送的待办' };
  }

  const { text: rendered, shownIds } = renderWeekly({
    overdue,
    inProgress,
    thisWeek,
    nextWeek,
    later,
    pending,
    ongoing,
  });

  let text = rendered;
  if (text.length > WEEKLY_MAX_CHARS) {
    text = `${text.slice(0, WEEKLY_MAX_CHARS - 20)}\n…（内容过长已截断）`;
  }

  await sendGroupMessage(group, text);
  // 发成功了才记账；抛错就不记，下一个周六还会补发
  markWeeklySent(group, t);
  // 只有真的写进消息里的才计数；被行数上限截断的下次还能再出现
  const bumped = bumpShown(shownIds);
  log.info(
    `周报已推送群 ${group}：逾期 ${overdue.length}、进行中 ${inProgress.length}、本周 ${thisWeek.length}、下周 ${nextWeek.length}、后续 ${later.length}、待定 ${pending.length}、无期限 ${ongoing.length}（单条 ${text.length} 字，计数 ${bumped} 项）`
  );
  return {
    sent: true,
    count:
      overdue.length +
      inProgress.length +
      thisWeek.length +
      nextWeek.length +
      pending.length +
      ongoing.length,
  };
}
