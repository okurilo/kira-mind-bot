import { composeUi, completeUi, type UiCompletion } from '../generative-ui/compose';
import { generativeUiCases } from '../tests/fixtures/generativeUiCases';

/** Only fictional questions/answers. No retrieval, Telegram, image input or business mutations. */
export async function evaluateGenerativeUi(completion: UiCompletion = completeUi) {
    const report = [];
    for (const item of generativeUiCases) {
        let responded = false, declined = false;
        const result = await composeUi(item.request, { id: -1, type: 'text', text: item.answer, format: 'plain' }, () => 'synthetic-eval-token', async (prompt, input) => {
            const raw = await completion(prompt, input);
            responded = true;
            const parsed = JSON.parse(raw);
            declined = !!parsed && Object.keys(parsed).length === 1 && parsed.components === null;
            return raw;
        });
        const components = result?.messages[0].createSurface.components ?? [];
        const chartValues = components.flatMap(component => component.component === 'Chart' ? component.series.flatMap(series => series.values) : []);
        const grounded = chartValues.every(value => item.values.includes(value));
        const validDecision = declined || !!result;
        const passed = validDecision && !!result === item.widget && grounded;
        report.push({ id: item.id, passed, widget: !!result, groundedChart: grounded,
            status: !responded ? 'provider_unavailable' : !validDecision ? 'invalid_schema' : 'evaluated' });
    }
    return { syntheticOnly: true, passed: report.filter(item => item.passed).length, total: report.length, cases: report };
}
async function main() {
    if (!process.argv.includes('--live')) {
        console.log('Run with --live in a configured diagnostic runtime. Only synthetic answers are sent to the model.');
        process.exitCode = 2; return;
    }
    const report = await evaluateGenerativeUi();
    console.log(JSON.stringify(report));
    if (report.passed !== report.total) process.exitCode = 1;
}
if (require.main === module) main().catch(() => { console.error('Synthetic UI evaluation failed; provider details suppressed.'); process.exitCode = 1; });
