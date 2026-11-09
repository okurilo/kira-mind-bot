import type { BotContext } from '../types';

/** The answer remains usable by speech and by Telegram clients that cannot draw widget media. */
export const UI_ANSWER_TEXT_RULES = `К ответу может быть добавлена отдельная визуальная карточка. Сам текст ответа — короткая естественная реплика, пригодная для озвучки и самостоятельного чтения без карточки.
Не рисуй интерфейс в тексте: никаких ASCII-полос, псевдографики, текстовых макетов, Markdown-таблиц и блоков с языком text ради наглядности. Не используй Markdown-выделение звёздочками. Настоящий программный код допустим, если пользователь просит именно код.
Просьба «покажи наглядно» относится к отдельной карточке, а не к текстовой имитации виджета. Сохрани существенные факты, единицы, неопределённость и источники; не обещай появление карточки, поскольку она необязательна. Не добавляй служебные подписи о формате доставки.`;

export function uiAnswerTextRules(ctx: Pick<BotContext, 'sessionStorageKey' | 'generativeUiRequest' | 'chat' | 'session'>): string {
    if (ctx.sessionStorageKey?.startsWith('api:')) return ctx.generativeUiRequest?.enabled ? UI_ANSWER_TEXT_RULES : '';
    return process.env.KIRA_TELEGRAM_WIDGETS_ENABLED !== 'false' && ctx.chat?.type === 'private' && ctx.session?.isAllowedUser
        ? UI_ANSWER_TEXT_RULES : '';
}
