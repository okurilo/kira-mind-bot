import { AppDataSource } from '../data-source';
import { ChatEntity } from '../entity/ChatEntity';
import { getActiveBotProfile } from '../utils/botIdentity';
import { telegramChatMigrations } from './telegramChatMigration';

export interface ChatInfo {
    chatId: number;
    title: string;
    chatType: string;
    username?: string;
}

export async function upsertChat(info: ChatInfo): Promise<void> {
    try {
        if (await telegramChatMigrations.resolve(info.chatId) !== String(info.chatId)) return; // Ignore stale pre-migration metadata.
        const repo = AppDataSource.getRepository(ChatEntity);
        const idStr = info.chatId.toString();
        const profile = getActiveBotProfile();
        const existing = await repo.findOneBy({ chatId: idStr, profile });
        if (existing) {
            existing.title = info.title;
            existing.chatType = info.chatType;
            existing.username = info.username;
            await repo.save(existing);
        } else {
            const chat = repo.create({
                chatId: idStr,
                title: info.title,
                chatType: info.chatType,
                username: info.username,
                profile,
                publicMode: false,
                allowedDomains: [],
            });
            await repo.save(chat);
        }
    } catch (error) {
        console.error('[chatRegistry] upsertChat error:', error);
    }
}

export async function getAllChats(): Promise<ChatEntity[]> {
    try {
        const repo = AppDataSource.getRepository(ChatEntity);
        const chats = await repo.find({ where: { profile: getActiveBotProfile() }, order: { lastSeenAt: 'DESC' } });
        const registered = new Set(chats.map(chat => chat.chatId));
        const visible = await Promise.all(chats.map(async chat => {
            const canonical = await telegramChatMigrations.resolve(chat.chatId);
            return canonical === chat.chatId || !registered.has(canonical);
        }));
        return chats.filter((_chat, index) => visible[index]);
    } catch (error) {
        console.error('[chatRegistry] getAllChats error:', error);
        return [];
    }
}

export async function isChatPublicMode(chatId: number): Promise<boolean> {
    try {
        const repo = AppDataSource.getRepository(ChatEntity);
        const chat = await repo.findOneBy({ chatId: await telegramChatMigrations.resolve(chatId), profile: getActiveBotProfile() });
        return chat?.publicMode ?? false;
    } catch (error) {
        console.error('[chatRegistry] isChatPublicMode error:', error);
        return false;
    }
}

export async function setChatPublicMode(chatId: number, enabled: boolean): Promise<void> {
    try {
        const repo = AppDataSource.getRepository(ChatEntity);
        await repo.update({ chatId: await telegramChatMigrations.resolve(chatId), profile: getActiveBotProfile() }, { publicMode: enabled });
    } catch (error) {
        console.error('[chatRegistry] setChatPublicMode error:', error);
    }
}

export async function getChatForbiddenTopics(chatId: number): Promise<string> {
    try {
        const repo = AppDataSource.getRepository(ChatEntity);
        const chat = await repo.findOneBy({ chatId: await telegramChatMigrations.resolve(chatId), profile: getActiveBotProfile() });
        return chat?.forbiddenTopics ?? '';
    } catch (error) {
        console.error('[chatRegistry] getChatForbiddenTopics error:', error);
        return '';
    }
}

export async function setChatForbiddenTopics(chatId: number, topics: string): Promise<void> {
    try {
        const repo = AppDataSource.getRepository(ChatEntity);
        await repo.update({ chatId: await telegramChatMigrations.resolve(chatId), profile: getActiveBotProfile() }, { forbiddenTopics: topics });
    } catch (error) {
        console.error('[chatRegistry] setChatForbiddenTopics error:', error);
    }
}

export async function getChatAllowedDomains(chatId: number): Promise<string[]> {
    try {
        const repo = AppDataSource.getRepository(ChatEntity);
        const chat = await repo.findOneBy({ chatId: await telegramChatMigrations.resolve(chatId), profile: getActiveBotProfile() });
        return chat?.allowedDomains ?? [];
    } catch (error) {
        console.error('[chatRegistry] getChatAllowedDomains error:', error);
        return [];
    }
}

export async function setChatAllowedDomains(chatId: number, domains: string[]): Promise<void> {
    try {
        const repo = AppDataSource.getRepository(ChatEntity);
        await repo.update({ chatId: await telegramChatMigrations.resolve(chatId), profile: getActiveBotProfile() }, { allowedDomains: domains });
    } catch (error) {
        console.error('[chatRegistry] setChatAllowedDomains error:', error);
    }
}
