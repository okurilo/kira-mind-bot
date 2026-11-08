import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { validateUiPayload, validateUiChange } from '../generative-ui/validate';
import { UI_CAPABILITY } from '../generative-ui/contracts';
import { uiExampleFiles } from '../scripts/generateUiExamples';
import { uiSchemas, updateUiOpenApi } from '../scripts/generateUiSchemas';

test('theFixtureSnapshotsPassOrFailAsFiled: shared mobile fixtures agree with the complete wire validators', () => {
    const root = join(__dirname, '../generative-ui/examples');
    const schemas = uiSchemas(), ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema(schemas.v1); const v1 = ajv.getSchema(schemas.v1.$id)!, extension = ajv.compile(schemas.extension), v2 = ajv.compile(schemas.v2);
    let valid = 0, invalid = 0;
    for (const [name, expected] of Object.entries(uiExampleFiles())) {
        const raw = readFileSync(join(root, name), 'utf8'), value = JSON.parse(raw);
        assert.deepEqual(value, expected, 'Regenerate fixture: ' + name);
        if (!name.includes('/valid/') && !name.startsWith('valid/') && !name.includes('/invalid/') && !name.startsWith('invalid/')) continue;
        const extensionEnabled = name.startsWith('metadata/');
        const accepted = validateUiPayload(value, extensionEnabled) || validateUiChange(value);
        if (name.startsWith('invalid/') || name.includes('/invalid/')) { assert.equal(accepted, false, name); invalid++; }
        else {
            assert.equal(accepted, true, name);
            assert.equal(name.startsWith('v2/') ? v2(value) : extensionEnabled ? extension(value) : v1(value), true, name + ': ' + JSON.stringify(ajv.errors)); valid++;
        }
    }
    assert.ok(valid >= 25 && invalid >= 45);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'capabilities.json'), 'utf8')), UI_CAPABILITY);
    const history = JSON.parse(readFileSync(join(root, 'history.json'), 'utf8'));
    assert.ok(validateUiPayload(history.messages[0].ui)); assert.equal(history.messages[1].ui, undefined);
    assert.ok(readdirSync(join(root, 'v2/valid')).includes('form.json'));
});

test('schema generation and public/account OpenAPI have no drift or dangling internal references', () => {
    const schemas = uiSchemas();
    for (const [name, value] of [['generative-ui.schema.json', schemas.v1], ['generative-ui.metadata.schema.json', schemas.extension], ['generative-ui.v2.schema.json', schemas.v2]] as const) {
        assert.deepEqual(JSON.parse(readFileSync(join(__dirname, '../docs', name), 'utf8')), value);
    }
    const spec = JSON.parse(readFileSync(join(__dirname, '../api/openapi.json'), 'utf8'));
    assert.deepEqual(updateUiOpenApi(structuredClone(spec)), spec);
    function visit(value: any) {
        if (!value || typeof value !== 'object') return;
        if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
            const target = value.$ref.slice(2).split('/').reduce((node: any, key: string) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
            assert.ok(target, value.$ref);
        }
        Object.values(value).forEach(visit);
    }
    visit(spec);
    const accounts = JSON.parse(readFileSync(join(__dirname, '../api/accounts.openapi.json'), 'utf8'));
    for (const path of Object.keys(spec.paths).filter(p => p.startsWith('/ui'))) assert.ok(accounts.paths[path]?.$ref);
});
