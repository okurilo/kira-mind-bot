import { composeUi, completeUi, type UiCompletion } from '../generative-ui/compose';
import { generativeUiCases, generativeUiV2Cases } from '../tests/fixtures/generativeUiCases';
import { UI_CATALOG_ID, UI_CATALOG_V2, type UiCatalogId } from '../generative-ui/contracts';
import { feedbackMetrics } from '../generative-ui/service';
import { readFileSync } from 'node:fs';
import { renderTelegramWidget } from '../generative-ui/telegramRender';

/** Only fictional questions/answers. No retrieval, Telegram, image input or business mutations. */
export async function evaluateGenerativeUi(completion: UiCompletion = completeUi, options: { catalogId?: UiCatalogId; deviceFeedback?: ReturnType<typeof feedbackMetrics>; transport?: 'telegram' } = {}) {
    const catalogId = options.catalogId ?? UI_CATALOG_ID;
    const report = [];
    const cases: Array<typeof generativeUiCases[number] & { expected?: string }> = [...generativeUiCases, ...(catalogId === UI_CATALOG_V2 ? generativeUiV2Cases : [])];
    for (const item of cases) {
        let responded = false, declined = false;
        const result = await composeUi(item.request, { id: -1, type: 'text', text: item.answer, format: 'plain' }, () => options.transport === 'telegram' ? 'w0' : 'synthetic-eval-token', async (prompt, input) => {
            const raw = await completion(prompt, input);
            responded = true;
            const parsed = JSON.parse(raw);
            declined = !!parsed && Object.keys(parsed).length === 1 && parsed.components === null;
            return raw;
        }, { request: { enabled: true, catalogId }, submitToken: () => options.transport === 'telegram' ? 'w0' : 'synthetic-form.signature' });
        const components = result?.messages[0].createSurface.components ?? [];
        const chartValues = components.flatMap(component => component.component === 'Chart' ? component.series.flatMap(series => series.values) : []);
        const grounded = chartValues.every(value => item.values.includes(value));
        const validDecision = declined || !!result;
        const expectedComponent = !item.expected || item.expected === 'meta' ? !item.expected || result?.meta?.asOf === '2041-04-12T19:00:00Z'
            && result.meta.sources?.[0]?.url === 'https://example.org/weather' : components.some(c => c.component === item.expected);
        const form = item.id !== 'form' || components.some(c => c.component === 'Button' && 'event' in c.action && c.action.event.name === 'kira.submit');
        const renderable = options.transport !== 'telegram' || !result || !!renderTelegramWidget(result);
        const passed = validDecision && !!result === item.widget && grounded && !!expectedComponent && form && renderable;
        report.push({ id: item.id, passed, widget: !!result, groundedChart: grounded,
            ...(options.transport ? { telegramRenderable: renderable } : {}),
            status: !responded ? 'provider_unavailable' : !validDecision ? 'invalid_schema' : 'evaluated' });
    }
    return { syntheticOnly: true, catalogId, passed: report.filter(item => item.passed).length, total: report.length, cases: report,
        deviceFeedback: options.deviceFeedback ?? feedbackMetrics([]) };
}
async function main() {
    if (!process.argv.includes('--live')) {
        console.log('Run with --live in a configured diagnostic runtime. Only synthetic answers are sent to the model.');
        process.exitCode = 2; return;
    }
    const feedbackPath = process.argv.find(v => v.startsWith('--feedback-file='))?.slice('--feedback-file='.length);
    let deviceFeedback: ReturnType<typeof feedbackMetrics> | undefined;
    if (feedbackPath) {
        // The owner endpoint returns counts and rejection codes only; never load widget/answer dumps for eval.
        const raw: any = JSON.parse(readFileSync(feedbackPath, 'utf8'));
        if (!raw || !['useful', 'notUseful', 'shownOnDevice', 'rejectedOnDevice'].every(k => Number.isSafeInteger(raw[k]) && raw[k] >= 0)
            || raw.unknownUnreported !== true || !raw.rejectionReasons || typeof raw.rejectionReasons !== 'object') throw Error('invalid_feedback_metrics');
        deviceFeedback = raw;
    }
    const report = await evaluateGenerativeUi(completeUi, { catalogId: process.argv.includes('--catalog=v2') ? UI_CATALOG_V2 : UI_CATALOG_ID, deviceFeedback,
        ...(process.argv.includes('--transport=telegram') ? { transport: 'telegram' as const } : {}) });
    console.log(JSON.stringify(report));
    if (report.passed !== report.total) process.exitCode = 1;
}
if (require.main === module) main().catch(() => { console.error('Synthetic UI evaluation failed; provider details suppressed.'); process.exitCode = 1; });
