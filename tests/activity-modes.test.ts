import assert from 'node:assert/strict';
import test from 'node:test';
import { activityModes, activityPreferences, inferActivityMode } from '../ai/activityModes';
import { BACKGROUND_FEATURE_KEYS, BACKGROUND_FEATURES } from '../ai/backgroundFeatures';
import { parseSettingsPatch } from '../api/settings';
const { registerBackgroundFeatureRoutes, resolvePreferences } = require('../admin-panel/backgroundFeatures');

test('activity catalog describes real complete presets with valid dependencies and the approved names', () => {
    assert.deepEqual(activityModes().map(item => item.title), ['По моей инициативе', 'Помнит важное', 'Помогает заранее', 'Максимальный', 'Настроить под себя']);
    for (const item of activityModes()) {
        assert.ok(item.description && item.benefits.length && item.costNote);
        if (item.key === 'custom') { assert.equal(item.featureKeys, null); continue; }
        const preferences = activityPreferences(item.key);
        assert.deepEqual(Object.keys(preferences).sort(), [...BACKGROUND_FEATURE_KEYS].sort());
        assert.equal(inferActivityMode(preferences), item.key);
        for (const feature of BACKGROUND_FEATURE_KEYS.filter(key => preferences[key])) {
            for (const parent of BACKGROUND_FEATURES[feature].requires) assert.equal(preferences[parent as keyof typeof preferences], true, feature + ' needs ' + parent);
        }
    }
    assert.ok(Object.values(activityPreferences('on_demand')).every(value => !value));
    assert.ok(Object.values(activityPreferences('maximum')).every(Boolean));
    assert.equal(activityPreferences('memory').telegramReading, false);
    assert.equal(activityPreferences('memory').kiraLife, false);
    assert.equal(activityPreferences('proactive').personalChatMemory, false);
    for (const [a,b] of [['on_demand','memory'], ['memory','proactive'], ['proactive','maximum']] as const) {
        for (const key of BACKGROUND_FEATURE_KEYS) if (activityPreferences(a)[key]) assert.equal(activityPreferences(b)[key], true);
    }
    const manual = { ...activityPreferences('memory'), kiraLife: true };
    assert.equal(inferActivityMode(manual), 'custom');
});

test('public settings apply presets explicitly, preserve legacy patches, and reject conflicting or unknown selections', () => {
    for (const key of ['on_demand','memory','proactive','maximum'] as const) {
        const patch = parseSettingsPatch({ activityMode: key });
        assert.equal(patch.activityMode, key); assert.equal(patch.budgetMode, 'normal');
        assert.deepEqual(patch.background, activityPreferences(key));
    }
    assert.equal(parseSettingsPatch({ activityMode: 'memory', budgetMode: 'maximum' }).budgetMode, 'maximum');
    assert.deepEqual(parseSettingsPatch({ background: { kiraLife: false } }), { background: { kiraLife: false } });
    assert.deepEqual(parseSettingsPatch({ activityMode: 'custom', background: { kiraLife: false } }), { activityMode: 'custom', background: { kiraLife: false } });
    for (const body of [{ activityMode: 'unknown' }, { activityMode: '__proto__' }, { activityMode: {} }, { activityMode: 'custom' },
        { activityMode: 'custom', background: {} }, { activityMode: 'maximum', background: { reflection: false } },
        { activityMode: 'maximum', autonomousAiEnabled: true }, { activityMode: 'maximum', background: {} }]) {
        assert.throws(() => parseSettingsPatch(body), { code: 'invalid_settings' });
    }
});

test('admin activity selection is authenticated and atomic, matches the API catalog and keeps failed writes unchanged', async () => {
    const routes = new Map<string, Function>(), rows = new Map<string,string>();
    const auth = () => {}; let failWrite = false, writeCount = 0;
    registerBackgroundFeatureRoutes({ get(_p: string, middleware: Function, handler: Function) { assert.equal(middleware,auth);routes.set('GET',handler); },
        post(_p: string, middleware: Function, handler: Function) { assert.equal(middleware,auth);routes.set('POST',handler); } }, {
        requireAuth: auth, ensureBotSettingsTable: async () => {}, readEnvFile: () => ({ KIRA_PUBLIC_ACCOUNT: 'true' }),
        createDbPool: () => ({ async query(sql:string, values:any[]) {
            if (sql.startsWith('SELECT')) return { rows: [...rows].map(([key,value]) => ({key,value})) };
            assert.match(sql,/unnest/); writeCount++; if (failWrite) throw Error('synthetic write failure');
            assert.equal(values[0].length,BACKGROUND_FEATURE_KEYS.length+1);
            values[0].forEach((key:string,index:number) => rows.set(key,values[1][index])); return { rows: [] };
        }, async end() {} }),
    });
    let status=200, body:any;const res={status(code:number){status=code;return res;},json(value:any){body=value;}};
    await routes.get('GET')!({},res);
    assert.equal(body.activityMode,'on_demand'); assert.equal(rows.size,0,'reading never applies a default preset');
    assert.deepEqual(body.activityModes,activityModes());
    await routes.get('POST')!({body:{activityMode:'memory'}},res);assert.equal(body.success,true);assert.equal(writeCount,1);
    assert.equal(rows.get('BUDGET_MODE'),'normal');
    await routes.get('GET')!({},res);assert.equal(body.activityMode,'memory');
    assert.equal(body.features.find((f:any)=>f.key==='deferredFacts').effective,true);
    assert.equal(rows.get('background:telegramReading'),'false');
    const before=[...rows];failWrite=true;
    await routes.get('POST')!({body:{activityMode:'maximum'}},res);assert.equal(status,500);assert.deepEqual([...rows],before);
    for (const value of ['custom','__proto__','invalid']) { await routes.get('POST')!({body:{activityMode:value}},res);assert.equal(status,400); }
    await routes.get('POST')!({body:{activityMode:'maximum',feature:'kiraLife',enabled:false}},res);assert.equal(status,400);
    assert.deepEqual([...rows],before);
    assert.ok(Object.values(resolvePreferences([], { KIRA_PUBLIC_ACCOUNT:'true' })).every(value=>value===false));
});
