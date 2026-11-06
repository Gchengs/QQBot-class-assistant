import { listActive } from '../store/todos.js';
import { renderReminderGroups } from './render.js';
import { sendLongGroupMessage } from '../qq/api.js';
import { today, addDays } from '../utils/date.js';
import { log } from '../logger.js';

/**
 * 到期提醒：同时看「今天截止」和「明天截止」。
 * 只看明天会漏掉当天才发现的问题，而当天截止的项往往最急。
 *
 * 区间任务（「11月9日～11月27日内完成」）开始日也要提醒一次——
 * 只提醒截止日的话，前面十天没人知道该开始做了。
 */
export async function pushReminder(group) {
  const t = today();
  const tomorrow = addDays(t, 1);
  const all = listActive(group);

  const startToday = all.filter((x) => x.due_start === t && x.due >= t);
  const startTomorrow = all.filter((x) => x.due_start === tomorrow && x.due >= t);
  const dueToday = all.filter((x) => x.due === t);
  const dueTomorrow = all.filter((x) => x.due === tomorrow);

  const total =
    startToday.length + startTomorrow.length + dueToday.length + dueTomorrow.length;
  if (!total) return { sent: false, count: 0 };

  const text = renderReminderGroups([
    { label: '今天开始', items: startToday },
    { label: '明天开始', items: startTomorrow },
    { label: '今天到期', items: dueToday },
    { label: '明天到期', items: dueTomorrow },
  ]);
  if (!text) return { sent: false, count: 0 };

  const sent = await sendLongGroupMessage(group, text);
  log.info(
    `到期提醒已推送群 ${group}：开始 ${startToday.length + startTomorrow.length} 项、到期 ${dueToday.length + dueTomorrow.length} 项，分 ${sent.length} 条`
  );
  return { sent: true, count: total };
}
