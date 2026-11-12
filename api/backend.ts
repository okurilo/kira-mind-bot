import { commerceCatalog } from '../services/commerce/catalog';
import { Bot, Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import { readModelPreferences, saveModelPreferences } from '../services/modelPreferenceService';
import { COMMUNICATION_CAPABILITY, CommunicationProfileService, type CommunicationPatch } from '../services/communicationProfileService';
import type { Update, UserFromGetMe } from 'grammy/types';
import { config } from '../config';
import { BOT_CAPABILITIES } from '../capabilities';
import { BotContext, SessionData } from '../types';
import { registerCallback } from '../callbacks';
import { registerCommandHandlers } from '../handlers/commands';
import { registerTextMessageHandler } from '../handlers/textMessages';
import { handleOwnerPhoto } from '../handlers/photoMessages';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import { ReminderRegistry } from '../stores/ReminderRegistry';
import { RecurringTaskRepository } from '../services/RecurringTaskRepository';
import { ApiBackend, ApiError, ApiReply } from './contracts';
import { BrowserSessionApi } from './browser';
import { ApiActionTokens } from './actionTokens';
import { ApiFiles } from './files';
import { ApiTransport, nextApiMessageId } from './transport';
import { ExternalApiOptions } from './options';
import { readUserSettings, updateUserSettings } from '../services/userSettingsService';
import type { ApiSettingsPatch } from './settings';
import { ApiModelCatalog, ApiModelSettingsStore, BotSettingsApiModelStore, apiTurnPreset, buildApiModelSettings,
    saveApiModelSelection } from './modelSettings';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';
import { SceneService, type SceneChannel, type ScenePreparation, type SceneTurn, type VisionRoute } from './scene';
import { addToHistory } from '../utils/history';
import type { AiPresetName } from '../ai/modelPresets';
import { registerDialogueLifecycle, publicDialogueJob, activateDialogueJob } from '../services/dialogueJobs';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { MAX_PHOTO_BYTES, PHOTO_STORAGE_NOTE, photoVisionRoute } from './photos';
import { registerProductAnalytics, recordDeferredOutcome } from '../services/productAnalytics';
import { WorkoutHttpApi } from './workouts/http';
import { WorkoutService } from '../services/workouts/service';
import { PgWorkoutStore } from '../services/workouts/store';
import { AppDataSource } from '../data-source';
import { getActiveBotProfile } from '../utils/botIdentity';
import { isApiOnlyRuntime } from '../utils/runtimeIdentity';
import { UI_CAPABILITY, UI_CATALOG_V2, type UiRequest, type UiValues, type UiPlacement } from '../generative-ui/contracts';
import { composeUi } from '../generative-ui/compose';
import { UiService } from '../generative-ui/service';
import { uiCapability } from '../generative-ui/contracts';
import { withUiRefreshCapture, uiRefreshEvidence } from '../generative-ui/refreshEvidence';
import type { RefreshRecipe } from '../generative-ui/refreshTemplate';
import { UiHttpApi } from './ui';
import { submissionText, validateSubmission } from '../generative-ui/forms';

/** Same handlers, orchestrator, identity and knowledge; only the delivery and session channel differ. */
export class BotApiBackend implements ApiBackend {
    private uiHttp?: UiHttpApi;
    private get widgets() { return this.uiService ??= new UiService(this.options.ownerId); }
    get uiApi() { return this.uiHttp ??= new UiHttpApi(this.widgets); }
    private workoutApi?: WorkoutHttpApi;
    get workouts() { return this.workoutApi ??= new WorkoutHttpApi(new WorkoutService(new PgWorkoutStore(AppDataSource), { profile: getActiveBotProfile(), ownerId: this.options.ownerId })); }
    readonly browserSession: BrowserSessionApi;
    private readonly dispatcher: Bot<BotContext>;
    private readonly storage = new TypeORMSessionStorage(true);
    private readonly files = new ApiFiles();
    private readonly actions: ApiActionTokens;
    private readonly sessionKey: string;
    private readonly botInfo: UserFromGetMe;
    private readonly photoInputs = new Map<string, Buffer>();

    constructor(private readonly bot: Bot<BotContext>, private readonly options: ExternalApiOptions,
                private readonly models: ApiModelSettingsStore = new BotSettingsApiModelStore(),
                private readonly catalog = new ApiModelCatalog(), private uiService?: UiService) {
        this.sessionKey = `api:${options.ownerId}`;
        this.browserSession = new BrowserSessionApi(options.ownerId, this.sessionKey, async work => {
            const preset = await apiTurnPreset(this.models);
            return runWithChannelPreset(preset, work);
        });
        this.actions = new ApiActionTokens(options.token, options.ownerId);
        this.botInfo = bot.botInfo;
        this.dispatcher = new Bot<BotContext>(config.botToken, { botInfo: this.botInfo });
        registerProductAnalytics(this.dispatcher);
        registerDialogueLifecycle(this.dispatcher);
        registerCallback(this.dispatcher);
        registerCommandHandlers(this.dispatcher);
        this.dispatcher.on('message:photo', async ctx => {
            const fileId = ctx.message.photo[0].file_id;
            const buffer = this.photoInputs.get(fileId);
            if (!buffer) throw new ApiError(400, 'invalid_photo', 'Фото недоступно. Отправь его ещё раз.');
            await handleOwnerPhoto(ctx, buffer, ctx.message.caption ?? '', fileId);
        });
        registerTextMessageHandler(this.dispatcher, { immediate: true });
        this.dispatcher.use(async ctx => { await ctx.reply('Команда не найдена. Посмотри /help.'); });
    }

    async status() {
        return { ok: true, apiVersion: 'v1', characterName: config.characterName, channel: 'api',
            sharedKnowledge: true, notificationsChannel: isApiOnlyRuntime() ? 'inbox' : 'telegram' };
    }

    async capabilities() {
        const vision: VisionRoute = await this.photoRoute().catch((error: unknown) => ({ available: false,
            reason: error instanceof ApiError ? error.message : 'Не удалось определить модель для анализа фото.' }));
        return { input: ['text', 'actions', 'photo'], photo: { mime: ['image/jpeg'], maxBytes: MAX_PHOTO_BYTES, vision, notes: PHOTO_STORAGE_NOTE }, output: ['text', 'photo', 'document', 'voice'],
            generativeUi: uiCapability(), browserSession: this.browserSession.capability, commerce: { version: 1, services: commerceCatalog() }, workouts: this.workouts.capability, profile: { communication: COMMUNICATION_CAPABILITY }, settings: ['modelMode', 'modelPreferences'], scene: { version: 1 }, deferredDialogue: { preference: 'respond-async', results: '/api/v1/dialogue-jobs', cancellation: true }, capabilities: BOT_CAPABILITIES };
    }

    settings() { return readUserSettings(); }
    modelPreferences() { return readModelPreferences(); }
    updateModelPreferences(body: unknown) { return saveModelPreferences(body); }
    updateSettings(patch: ApiSettingsPatch) { return updateUserSettings(patch); }
    communicationProfile() { return new CommunicationProfileService(this.options.ownerId).read(); }
    updateCommunicationProfile(patch: CommunicationPatch) { return new CommunicationProfileService(this.options.ownerId).patch(patch); }
    private sceneService?: SceneService;
    private get scene() { return this.sceneService ??= new SceneService(this.options.ownerId, this.models, this.sceneChannel()); }
    sceneCapabilities() { return this.scene.capabilities(); }
    sceneReady(turn: SceneTurn) { return this.scene.ready(turn); }
    sceneTurn(turn: SceneTurn, preset: AiPresetName | null) { return this.scene.turn(turn, preset); }
    scenePrepare(turn: ScenePreparation) { return this.scene.prepare(turn); }
    async sceneCancel(target: { plan: string } | { roomId: string; coordinateSpaceId: string }) { return this.scene.cancel(target); }
    sceneActionResult(body: Record<string, unknown>) { return this.scene.actionResult(body); }
    modelSettings() { return buildApiModelSettings(this.models, this.catalog); }
    async turnReady() { await apiTurnPreset(this.models); }
    private async photoRoute() {
        const preset = await apiTurnPreset(this.models);
        return runWithChannelPreset(preset, () => photoVisionRoute());
    }
    async photoReady(): Promise<AiPresetName | null> {
        try {
            const preset = await apiTurnPreset(this.models);
            const route = await runWithChannelPreset(preset, () => photoVisionRoute());
            if (!route.available) throw new ApiError(503, 'vision_unavailable', `Бот сейчас не может посмотреть фото: ${route.reason}`);
            return preset;
        } catch (error) {
            if (error instanceof ApiError) throw new ApiError(503, 'vision_unavailable', error.message);
            throw new ApiError(503, 'vision_unavailable', 'Не удалось проверить модель для анализа фото. Попробуй позже.');
        }
    }
    saveModelSettings(body: Record<string, unknown>) { return saveApiModelSelection(this.models, this.catalog, body); }

    async history(limit: number) {
        const session = await this.storage.read(this.sessionKey);
        return { messages: await Promise.all((session?.messageHistory ?? []).slice(0, limit).reverse().map(async item => {
            let ui = item.ui;
            if (ui?.catalogId === UI_CATALOG_V2 && !item.uiRefresh) {
                const surface = await this.widgets.surface(ui.messages[0].createSurface.surfaceId).catch(() => undefined);
                ui = surface && !surface.deleted ? surface.ui : undefined;
            }
            return { role: item.role === 'bot' ? 'assistant' : item.role, text: item.content, createdAt: item.timestamp.toISOString(),
                ...(ui ? { ui, ...(item.uiRefresh ? { uiRefresh: item.uiRefresh } : {}) } : {}), ...(item.apiMessageId ? { id: item.apiMessageId } : {}) };
        })) };
    }

    async reminders() {
        return { reminders: ReminderRegistry.getInstance().getActiveByChatId(this.options.ownerId).map(item => ({
            id: item.id, text: item.displayText || item.text, status: item.status,
            dueAt: new Date(item.dueDate).toISOString(), recurrence: item.recurrence,
        })) };
    }

    async tasks() {
        const tasks = await RecurringTaskRepository.listByChatId(this.options.ownerId);
        return { tasks: tasks.slice(0, 100).map(item => ({
            id: item.id, title: item.title, prompt: item.prompt, status: item.status,
            schedule: item.schedule, nextRunAt: item.nextRunAt, lastResult: item.lastResult,
        })), hasMore: tasks.length > 100 };
    }

    async dialogueJobs(ui?: { deviceId?: string; bindingId?: string; after?: string }) {
        const jobs = await DialogueJobRepository.list(this.sessionKey);
        for (const job of jobs) if (job.input.required && job.status === 'completed')
            await recordDeferredOutcome(job.input.analyticsTaskId, this.options.ownerId, job.error ? 'failed' : 'delivered', true);
        return { jobs: jobs.map(publicDialogueJob), ...(ui ? await this.widgets.events(ui) : {}) };
    }
    async cancelDialogueJob(id: string) { return { cancelled: await DialogueJobRepository.cancel(this.sessionKey, id) }; }

    file(id: string) { return this.files.read(id); }

    async message(text: string, options: { deferredDialogue?: boolean; preset?: AiPresetName | null; arRoom?: BotContext['arRoom']; liveBrowserRequest?: BotContext['liveBrowserRequest']; ui?: UiRequest; expectedVersion?: string } = {}): Promise<ApiReply> {
        const command = text.match(/^\/[a-zA-Z0-9_]+(?:@[a-zA-Z0-9_]+)?/);
        return this.dispatch({ update_id: 0, message: {
            message_id: nextApiMessageId(), date: Math.floor(Date.now() / 1000),
            from: this.owner(), chat: this.chat(), text,
            ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] } : {}),
        } }, { expectedVersion: options.expectedVersion, deferredDialogue: options.deferredDialogue === true, selectedPreset: options.preset,
            arRoom: options.arRoom, liveBrowserRequest: options.liveBrowserRequest, ui: options.ui });
    }

    validateAction(token: string, values?: UiValues) {
        const action = this.actions.inspect(token);
        if (action.data.startsWith('ui.submit:')) {
            let submission;
            try { submission = validateSubmission(JSON.parse(action.data.slice('ui.submit:'.length))); }
            catch { throw new ApiError(400, 'invalid_ui_values', 'Некорректная форма.'); }
            submissionText(submission, values);
        } else if (values !== undefined) throw new ApiError(400, 'invalid_ui_values', 'Эта кнопка не принимает поля формы.');
    }
    async action(token: string, ui?: UiRequest, values?: UiValues): Promise<ApiReply> {
        const action = this.actions.verify(token);
        this.validateAction(token, values);
        if (action.data.startsWith('ui.submit:')) {
            const submission = validateSubmission(JSON.parse(action.data.slice('ui.submit:'.length)));
            return this.message(submissionText(submission, values), { expectedVersion: action.version, ui });
        }
        // A quick reply is a new owner message through the canonical pipeline, never a privileged callback.
        if (action.data.startsWith('ui.reply:')) {
            return this.message(action.data.slice('ui.reply:'.length), { expectedVersion: action.version, ui });
        }
        return this.dispatch({ update_id: 0, callback_query: {
            id: String(nextApiMessageId()), from: this.owner(), chat_instance: 'external-api',
            data: action.data,
            message: {
                message_id: action.messageId, date: Math.floor(Date.now() / 1000),
                from: this.botInfo, chat: this.chat(), text: action.text,
            },
        } }, { confirmation: true, expectedVersion: action.data.startsWith('pa:') ? undefined : action.version, ui });
    }

    async photo(buffer: Buffer, caption = '', preset?: AiPresetName | null, ui?: UiRequest, arRoom?: BotContext['arRoom']): Promise<ApiReply> {
        const selected = preset === undefined ? await this.photoReady() : preset;
        const fileId = `api-photo-${randomUUID()}`;
        this.photoInputs.set(fileId, buffer);
        try {
            return await this.dispatch({ update_id: 0, message: {
                message_id: nextApiMessageId(), date: Math.floor(Date.now() / 1000), from: this.owner(), chat: this.chat(),
                ...(caption ? { caption } : {}), photo: [{ file_id: fileId, file_unique_id: fileId, width: 16, height: 16 }],
            } }, { selectedPreset: selected, arRoom, ui });
        } finally { this.photoInputs.delete(fileId); }
    }

    /** Room turns as turns of this same dialogue: words as /messages, a frame as /photos, the room as their context. */
    private sceneChannel(): SceneChannel {
        return {
            say: (text, room, preset, ui) => this.message(text, { preset, arRoom: room, ui }),
            look: (frame, text, room, preset, ui) => this.photo(frame, text, preset, ui, room),
            visionRoute: () => photoVisionRoute(),   // under the mode the scene service sets
            recent: async () => (await this.storage.read(this.sessionKey))?.messageHistory ?? [],
            note: async line => {
                const persisted = await this.storage.read(this.sessionKey);
                const ctx = { session: Object.assign({ reminders: [], messageHistory: [], dialogueSummary: '', lastSummarizedIndex: -1,
                    domains: {}, sentMessages: {} }, persisted), sessionStorageKey: this.sessionKey } as unknown as BotContext;
                await addToHistory(ctx, 'bot', line);
                await this.storage.write(this.sessionKey, ctx.session);
            },
        };
    }

    private owner() { return { id: this.options.ownerId, is_bot: false, first_name: 'Владелец' }; }
    private chat() { return { id: this.options.ownerId, type: 'private' as const, first_name: 'Владелец' }; }

    private async dispatch(update: Update, { confirmation = false, expectedVersion, deferredDialogue = false, selectedPreset, arRoom, liveBrowserRequest, ui }: {
        confirmation?: boolean; expectedVersion?: string; deferredDialogue?: boolean; selectedPreset?: AiPresetName | null;
        arRoom?: BotContext['arRoom']; liveBrowserRequest?: BotContext['liveBrowserRequest']; ui?: UiRequest;
    } = {}): Promise<ApiReply> {
        const persisted = await this.storage.read(this.sessionKey);
        if (expectedVersion !== undefined && persisted?.apiActionVersion !== expectedVersion) {
            throw new ApiError(410, 'action_expired', 'Кнопка относится к предыдущему запросу. Повтори исходный запрос.');
        }
        const version = randomUUID();
        const transport = new ApiTransport(config.botToken, this.options.ownerId, this.actions,
            this.files, this.bot.api, confirmation, version);
        const ctx = new Context(update, transport.api, this.botInfo) as BotContext;
        const initial: SessionData = {
            reminders: [], messageHistory: [], dialogueSummary: '', lastSummarizedIndex: -1,
            domains: {}, sentMessages: {},
        };
        ctx.session = Object.assign(initial, persisted, {
            reminders: ReminderRegistry.getInstance().getActiveByChatId(this.options.ownerId), isAllowedUser: true,
            apiActionVersion: version,
        });
        ctx.sessionStorageKey = this.sessionKey;
        // v1 widgets are atomic snapshots of a complete answer. Prefer is optional; do not stage a text-only job.
        ctx.allowDeferredDialogue = deferredDialogue && (!ui || ui.catalogId === UI_CATALOG_V2);
        ctx.generativeUiRequest = ui;
        ctx.arRoom = arRoom;
        ctx.liveBrowserRequest = liveBrowserRequest;
        const priorHistory = new Set(ctx.session.messageHistory);
        let widgetPlacement: UiPlacement | undefined;
        // The app's own text mode, read once per turn; null follows the server's global preset.
        const preset = selectedPreset === undefined ? await apiTurnPreset(this.models) : selectedPreset;
        await withUiRefreshCapture(ui?.refresh === true, () => runWithChannelPreset(preset, async () => {
            await this.dispatcher.middleware()(ctx, async () => {});
            if (ui && !ctx.dialogueJobId) {
                const message = transport.result().messages.filter(item => item.type === 'text' && item.text && item.replacesMessageId === undefined).at(-1);
                if (message) {
                    const fileIds = new Set(transport.result().messages.filter(m => m.type === 'photo' || /\.(png|jpe?g|gif|webp)$/i.test(m.filename ?? ''))
                        .flatMap(m => m.fileUrl?.match(/^\/api\/v1\/files\/([a-f0-9-]{36})$/)?.[1] ?? []));
                    let refreshRecipe: RefreshRecipe | undefined;
                    const payload = await composeUi(update.message?.text ?? update.message?.caption ?? '', message,
                        text => this.actions.sign(message.id, `ui.reply:${text}`, message.text ?? '', version), undefined, {
                            request: ui, files: fileIds, sceneObjects: arRoom?.uiObjects,
                            refreshSources: uiRefreshEvidence(), onRefreshRecipe: value => { refreshRecipe = value; },
                            onPlacement: value => { widgetPlacement = value; },
                            submitToken: (text, fields) => this.actions.sign(message.id, 'ui.submit:' + JSON.stringify({ text, fields }), message.text ?? '', version),
                        });
                    if (payload) {
                        try {
                            if (ui.target) { await this.widgets.update(ui.target.surfaceId, ui.target.revision, payload); widgetPlacement = undefined; }
                            else {
                                await this.widgets.record(payload, message.id, ui); message.ui = payload;
                                message.uiRefresh = await this.widgets.refresh.register(payload, refreshRecipe, ui).catch(() => undefined);
                                const historyEntry = ctx.session.messageHistory.find(item => !priorHistory.has(item) && item.role === 'bot' && item.content === message.text);
                                if (historyEntry) { historyEntry.ui = payload; historyEntry.apiMessageId = message.id; historyEntry.uiRefresh = message.uiRefresh; }
                                else ctx.session.messageHistory.unshift({ role: 'bot', content: message.text!, timestamp: new Date(), ui: payload, apiMessageId: message.id, uiRefresh: message.uiRefresh });
                            }
                        } catch { widgetPlacement = undefined; /* Optional visual persistence cannot discard a completed answer. */ }
                    }
                }
                // Bound presentation storage independently of text history. Existing session merge/JSON handles it.
                let retained = 0;
                for (const item of ctx.session.messageHistory) if (item.ui && ++retained > 20) {
                    delete item.ui; delete item.apiMessageId; delete item.uiRefresh;
                }
            }
        }));
        await this.storage.write(this.sessionKey, ctx.session);
        if (ctx.dialogueJobId) await activateDialogueJob(ctx, ctx.dialogueJobId);
        const result = transport.result();
        if (widgetPlacement) result.widgetPlacement = widgetPlacement;
        if (ctx.dialogueJobId) {
            const job = await DialogueJobRepository.find(ctx.dialogueJobId, this.sessionKey);
            if (job) result.backgroundJob = { id: job.id, status: job.status, required: job.input.required };
        }
        return result;
    }
}
