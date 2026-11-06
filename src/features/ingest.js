import { config } from '../config.js';
import { log } from '../logger.js';
import { addTodo } from '../store/todos.js';
import { parseExplicit, inferTodo, inferTodoByRules } from './extract.js';
import { llmEnabled } from '../llm.js';
import { cleanContent, handleAtMessage } from './atReply.js';
import { getSelfOpenid } from '../qq/api.js';
import { parseBaseDate } from '../utils/date.js';

/**
 * 处理群内普通消息（全量模式）。
 * 原则：静默入库，不在群里刷屏；只有 @ 机器人才回复。
 */
/**
 * 这条消息是不是在 @ 机器人自己。
 *
 * 必须判断，因为「接收全部消息」模式下平台有时只推 GROUP_MESSAGE_CREATE，
 * 不再单独推 GROUP_AT_MESSAGE_CREATE。表现就是：机器人在线、群消息也收得到，
 * 但 @ 它一声不响。正文里的 `<@!openid>` 是唯一还留着的证据。
 */
async function isAtSelf(d) {
  const raw = String(d.content || '');
  const mentions = d.mentions || [];
  if (mentions.some((m) => m && (m.bot === true || m.is_you === true))) return true;

  const selfId = await getSelfOpenid();
  if (selfId && (raw.includes(`<@!${selfId}>`) || raw.includes(`<@${selfId}>`))) return true;
  if (selfId && mentions.some((m) => (m?.member_openid || m?.id) === selfId)) return true;

  // 拿不到自身 id 时的兜底：正文里确实有 @ 标记，且去掉标记后剩下的是一条指令。
  // 群里 @ 别人说「周报」几乎不会发生，这个判断很安全。
  const atIds = [...raw.matchAll(/<@!?([^>]+)>/g)].map((m) => m[1]);
  if (!selfId && atIds.length) {
    return /^(周报|本周|weekly|待办|清单|帮助|help|指令|命令|[#＃])/i.test(cleanContent(raw));
  }

  // 内容像在使唤机器人、@ 的却不是它 —— 把 id 记下来，下次有人问「为什么 @ 了没反应」
  // 直接看这行就知道他 @ 的是谁。
  if (atIds.length && /^(周报|本周|weekly|待办|清单|帮助|help|指令|命令|[#＃])/i.test(cleanContent(raw))) {
    log.warn(
      `有人 @「${atIds.join('、')}」发了指令，但那不是本机器人（本机器人 id=${selfId || '未取到'}）`
    );
  }
  return false;
}

export async function ingestMessage(d) {
  const group = d.group_openid;
  const author = d.author || {};
  if (author.bot) return;

  if (await isAtSelf(d)) {
    log.info('全量事件里识别到 @ 机器人，按 @ 消息回复');
    return handleAtMessage(d);
  }

  const content = cleanContent(d.content);
  if (!content) return;

  // 全量模式下每条群消息都留一行痕迹（截断 40 字）。
  // 没有这行日志，「群主到底把权限开没开」「消息进没进来」完全看不出来——
  // 之前排查半天，就是因为收不到消息时服务端一声不响。
  // 不想在日志里留聊天内容，把 LOG_GROUP_MESSAGES 设成 false 即可。
  if (config.logGroupMessages) {
    const who = author.username || author.id || '未知';
    const brief = content.replace(/\s+/g, ' ').slice(0, 40);
    log.info(
      `收到群消息〔${who}〕${brief}${content.length > 40 ? '…' : ''}（${content.length} 字）`
    );
  }

  // 相对时间的基准必须来自这条消息自己，不能用「现在」。
  // 停机后补发、事件重放、或者消息堆积几个小时后才处理，
  // 用「现在」算出来的「今天下午」会整个偏掉。
  // 拿不到时间戳就是 null：宁可把「明天交」存成日期待定，也不猜一个日期出来。
  const base = parseBaseDate(d.timestamp);
  if (!base) {
    log.warn(
      `消息 ${d.id || '?'} 没有可用的发送时间，「今天/明天/下周」这类相对日期不解析，按日期待定入库`
    );
  }

  if (!config.groupOpenids.length || config.groupOpenids.includes(group)) {
    // 显式指令始终生效
    if (/^[#＃]待办\s+/.test(content)) {
      const parsed = parseExplicit(content, d.mentions, base);
      if (!parsed) return;
      const { todo, duplicated } = addTodo({
        group,
        title: parsed.title,
        owner: parsed.owner,
        ownerInferred: parsed.ownerInferred,
        ownerOpenid: parsed.ownerOpenid,
        due: parsed.due,
        dueStart: parsed.dueStart,
        dueTime: parsed.dueTime,
        timeState: parsed.timeState,
        sourceMsgId: d.id,
        sourceText: content,
        source: 'manual',
      });
      if (!duplicated) {
        log.info(`入库（指令）：${todo.title}${todo.due ? ` @${todo.due}` : ''}`);
      } else {
        log.debug(`重复待办，已跳过：${todo.title}`);
      }
      return;
    }

    if (!config.fullMessageMode) return;

    // 有 API Key 就用模型，没有就退回规则版。
    // 之前这里是大模型不可用就直接 return null，等于「全量模式」形同虚设，
    // 群里聊得再热闹也一条都进不来，而且不打任何日志。
    let inferred = null;
    if (llmEnabled()) {
      inferred = await inferTodo(content, {
        mentions: d.mentions || [],
        senderName: author.username || '',
        base,
      });
    } else if (config.ruleExtract) {
      inferred = inferTodoByRules(content, { mentions: d.mentions || [], base });
    }
    if (!inferred) return;

    const { todo, duplicated } = addTodo({
      group,
      title: inferred.title,
      owner: inferred.owner,
      ownerOpenid: inferred.ownerOpenid,
      due: inferred.due,
      dueStart: inferred.dueStart,
      dueTime: inferred.dueTime,
      timeState: inferred.timeState,
      sourceMsgId: d.id,
      sourceText: content,
      source: llmEnabled() ? 'auto' : 'rule',
    });
    if (!duplicated) {
      log.info(
        `入库（自动）：${todo.title}${todo.owner ? ` 〔${todo.owner}〕` : ''}${
          todo.due ? ` 截止${todo.due}` : ''
        }`
      );
    }
  }
}
