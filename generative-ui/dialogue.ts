import type { DialogueJob } from '../types/dialogueJobTypes';
import { composeUi, type UiCompletion } from './compose';
import { UiService } from './service';
import { ApiActionTokens } from '../api/actionTokens';
import { readExternalApiOptions } from '../api/options';
import { nextApiMessageId } from '../api/transport';
import type { UiChange, UiPayload } from './contracts';

/** Called under the original task/preset, with an atomic current-turn guard in the presentation store. */
export async function composeDialogueUi(job: DialogueJob, answer: string, active: () => Promise<boolean>,
    dependencies: { service?: UiService; actions?: ApiActionTokens; complete?: UiCompletion } = {}): Promise<{ ui: UiPayload | UiChange; messageId: number } | undefined> {
    if (!job.input.ui || job.input.ui.request.catalogId !== 'urn:kira:ui:catalog:2' || !job.channel.startsWith('api:')) return;
    try {
        const options = dependencies.actions ? undefined : readExternalApiOptions(process.env, job.userId);
        const actions = dependencies.actions ?? (options && new ApiActionTokens(options.token, job.userId));
        if (!actions || !await active()) return;
        const service = dependencies.service ?? new UiService(job.userId), messageId = nextApiMessageId();
        const { request, version } = job.input.ui;
        const ui = await composeUi(job.input.message, { id: messageId, type: 'text', text: answer, format: 'plain' },
            text => actions.sign(messageId, 'ui.reply:' + text, answer, version), dependencies.complete, {
                request, submitToken: (text, fields) => actions.sign(messageId, 'ui.submit:' + JSON.stringify({ text, fields }), answer, version),
            });
        if (!ui || !await active()) return;
        if (request.target) {
            const change = await service.update(request.target.surfaceId, request.target.revision, ui, active);
            const surface = await service.surface(request.target.surfaceId);
            return { ui: change, messageId: surface!.messageId };
        }
        await service.record(ui, messageId, request, active);
        return { ui, messageId };
    } catch { return; /* An optional visual cannot replace a completed textual answer. */ }
}
