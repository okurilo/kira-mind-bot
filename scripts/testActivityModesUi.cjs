'use strict';
// Actual React/admin and account-console code, with synthetic API and no real accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function buildHarness(outDir) {
  const root = path.resolve(__dirname, '../admin-panel');
  const { build } = await import(pathToFileURL(require.resolve('vite', { paths: [root] })).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react', { paths: [root] })).href);
  const result = await build({ root, configFile: false, plugins: [react(), {
    name: 'activity-ui-fixture', resolveId(id) { if (id === 'virtual:activity-ui') return '\0activity-ui.tsx'; },
    load(id) { if (id === '\0activity-ui.tsx') return `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ThemeProvider,CssBaseline} from '@mui/material';import {theme} from '/src/theme.ts';
      import {BudgetSettingsSection} from '/src/components/BudgetSettingsSection.tsx';
      createRoot(document.getElementById('root')).render(<ThemeProvider theme={theme}><CssBaseline/><main style={{maxWidth:960,margin:'auto',padding:16}}><BudgetSettingsSection onToast={()=>{}}/></main></ThemeProvider>);
    `; },
  }], build: { outDir, emptyOutDir: true, rollupOptions: { input: 'virtual:activity-ui' } } });
  const output = Array.isArray(result) ? result[0].output : result.output;
  const entry = output.find(item => item.type === 'chunk' && item.isEntry);
  assert.ok(entry);
  await fs.writeFile(path.join(outDir, 'index.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/${entry.fileName}"></script></html>`);
}

async function run(harness) {
  Object.assign(process.env, { NODE_ENV:'test',KIRA_BOT_TOKEN:'synthetic-test-token',OPENAI_API_KEY:'synthetic-test-key',TELEGRAM_API_ID:'',TELEGRAM_API_HASH:'',TELEGRAM_SESSION_STRING:'' });
  const { chromium } = require('playwright');
  const catalog = require('../ai/activityModeCatalog');
  const { buildFeatureStates } = require('../ai/backgroundFeatureState');
  const { parseSettingsPatch } = require('../dist/api/settings');
  const { ACCOUNT_CONSOLE_CSP } = require('../dist/platform/publicAccounts/webHttp');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage'] });
  try {
    for (const kind of ['admin','portal']) {
      let preferences=catalog.activityPreferences('on_demand'),budget='normal',failWrite=false,failRead=false,holdSession=false,releaseSession;
      const writes=[],errors=[];
      const snapshot=()=>({mode:budget,budgetMode:budget,budgetModes:[],activityMode:catalog.inferActivityMode(preferences),activityModes:catalog.activityModes(),
        telegram:{personalSessionConfigured:false},features:buildFeatureStates(preferences,budget,false)});
      const context=await browser.newContext({viewport:{width:1100,height:950}});
      const origin='https://synthetic.example.invalid';
      const counter=(limit,used)=>({limit,used,reserved:0,remaining:limit-used});
      let quota={day:'2037-01-01',resetAt:'2037-01-02T00:00:00Z',dialogue:counter(20,3),background:counter(60,60),images:counter(1,0),legacyAi:{used:7,reserved:0}};
      let quotaFailure=false;
      await context.route('**/*', async route=>{
        const request=route.request(),url=new URL(request.url()),endpoint=url.pathname;
        const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
        if(url.origin!==origin)return route.abort();
        if(endpoint==='/api/auth/context')return json({csrfEnabled:true,csrfToken:'synthetic-csrf'});
        if(endpoint==='/api/v1/web/config')return json({csrfToken:'synthetic-csrf',hasBrowserSession:true,providers:[]});
        if(endpoint==='/api/v1/web/session'){if(holdSession){holdSession=false;await new Promise(resolve=>{releaseSession=resolve;});}return json({account:{id:'11111111-1111-4111-8111-111111111111',username:'synthetic_account',runtimeState:'ready',autonomousAiEnabled:true,consent:{aiAllowed:true},quota}});}
        if(['/api/account-quota','/api/v1/web/api/account/quota'].includes(endpoint))return quotaFailure?json({error:kind==='portal'?{message:'Синтетическая ошибка квот'}:'Синтетическая ошибка квот'},503):json({available:true,version:1,quota});
        if(endpoint==='/api/v1/web/auth/pending')return json({pending:null});
        if(['/api/background-features','/api/v1/web/api/settings'].includes(endpoint)) {
          if(request.method()==='GET')return failRead?json({error:kind==='portal'?{message:'Синтетическая ошибка чтения'}:'Синтетическая ошибка чтения'},503):json(snapshot());
          assert.equal(request.headers()['x-csrf-token'],'synthetic-csrf');
          const body=request.postDataJSON();writes.push(body);
          if(failWrite)return json({error:kind==='portal'?{message:'Синтетическая ошибка сохранения'}:'Синтетическая ошибка сохранения'},503);
          if(kind==='admin') {
            if(body.activityMode){preferences=catalog.activityPreferences(body.activityMode);budget='normal';}
            else preferences={...preferences,[body.feature]:body.enabled};
          } else { const patch=parseSettingsPatch(body);preferences={...preferences,...patch.background};budget=patch.budgetMode||budget; }
          return json(kind==='portal'?snapshot():{success:true,message:'Сохранено',mode:budget});
        }
        if(endpoint==='/api/budget-mode') { const body=request.postDataJSON();writes.push(body);budget=body.mode;return json({mode:budget,message:'Сохранено'}); }
        const file=kind==='portal'?({'/account/':['account-console/index.html','text/html'],'/account/account.js':['account-console/account.js','application/javascript'],'/account/account.css':['account-console/account.css','text/css']}[endpoint]):[path.join(harness,endpoint==='/'?'index.html':endpoint.slice(1)),endpoint.endsWith('.js')?'application/javascript':endpoint.endsWith('.css')?'text/css':'text/html'];
        if(!file)throw Error('Unexpected synthetic path: '+endpoint);
        return route.fulfill({contentType:file[1]+'; charset=utf-8',body:await fs.readFile(file[0]),headers:kind==='portal'?{'content-security-policy':ACCOUNT_CONSOLE_CSP}:{}});
      });
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
      const url=origin+(kind==='portal'?'/account/':'/');
      const open=async()=>{await page.goto(url);if(kind==='portal')await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('radio',{name:'По моей инициативе',exact:true}).waitFor();};
      const save=()=>page.getByRole('button',{name:kind==='portal'?'Сохранить настройки':'Применить режим',exact:true}).click();
      const current=title=>page.getByText('Сейчас: '+title,{exact:true}).waitFor();
      try {
        await open();assert.equal(writes.length,0);await current('По моей инициативе');if(kind==='admin')assert.equal(await page.getByRole('button',{name:'Применить режим',exact:true}).isDisabled(),true);
        await page.locator('[data-quota="dialogue"]').getByText('Осталось 17 из 20',{exact:true}).waitFor();
        await page.locator('[data-quota="background"]').getByText('Новые фоновые задачи на паузе',{exact:true}).waitFor();
        await page.getByRole('radio',{name:'Помнит важное',exact:true}).check();assert.equal(writes.length,0,'a draft never saves itself');
        quota={...quota,dialogue:counter(20,20),background:counter(60,10)};
        await page.getByRole('button',{name:'Обновить квоты',exact:true}).click();
        await page.locator('[data-quota="background"]').getByText('Осталось 50 из 60',{exact:true}).waitFor();
        assert.equal(await page.getByRole('radio',{name:'Помнит важное',exact:true}).isChecked(),true,'refreshing quotas preserves the unsaved activity draft');
        quotaFailure=true;await page.getByRole('button',{name:'Обновить квоты',exact:true}).click();await page.getByText('Синтетическая ошибка квот',{exact:true}).waitFor();
        assert.equal(await page.getByRole('radio',{name:'Помнит важное',exact:true}).isChecked(),true);
        quotaFailure=false;await page.getByRole('button',{name:'Обновить квоты',exact:true}).click();await page.locator('[data-quota="background"]').getByText('Осталось 50 из 60',{exact:true}).waitFor();
        if(kind==='portal')holdSession=true;
        await save();
        if(kind==='portal'){
          for(let i=0;i<50&&!releaseSession;i++)await new Promise(resolve=>setTimeout(resolve,20));
          assert.ok(releaseSession);assert.equal(await page.getByRole('radio',{name:'Максимальный',exact:true}).isDisabled(),true,'the reviewed selection cannot change during session validation');releaseSession();
        }
        await current('Помнит важное');assert.equal(writes.length,1);assert.equal(writes[0].activityMode,'memory');assert.equal(writes[0].background,undefined);
        assert.deepEqual(preferences,catalog.activityPreferences('memory'));
        await open();await current('Помнит важное');assert.equal(writes.length,1,'reloading never applies a preset');
        await page.getByRole('radio',{name:'Максимальный',exact:true}).check();failWrite=true;await save();
        await page.getByText('Синтетическая ошибка сохранения',{exact:true}).waitFor();assert.equal(catalog.inferActivityMode(preferences),'memory');
        assert.equal(await page.getByRole('radio',{name:'Максимальный',exact:true}).isChecked(),true);
        failWrite=false;await save();await current('Максимальный');assert.equal(catalog.inferActivityMode(preferences),'maximum');
        assert.equal(snapshot().features.find(feature=>feature.key==='reflection').blockedBy,'telegram');
        const pause=page.getByRole('checkbox',{name:'Приостановить фоновый AI',exact:true});
        if(kind==='portal'){await pause.check();await save();}else{await pause.click();await page.waitForFunction(()=>document.getElementById('budget-mode')?.checked===true);}
        await page.waitForFunction(()=>document.body.textContent.includes('Сейчас: Максимальный'));
        for(let i=0;i<50&&budget!=='maximum';i++)await new Promise(resolve=>setTimeout(resolve,20));
        assert.equal(budget,'maximum');assert.equal(catalog.inferActivityMode(preferences),'maximum');
        await page.getByRole('radio',{name:'Настроить под себя',exact:true}).check();
        const group=kind==='portal'?page.locator('summary').filter({hasText:'Самостоятельная активность'}):page.getByRole('button',{name:/Самостоятельная активность/});
        await group.click();const life=page.getByRole('checkbox',{name:'Кира пишет первой',exact:true});if(kind==='portal')await life.uncheck();else await life.click();
        if(kind==='portal')await save();
        await current('Настроить под себя');assert.equal(preferences.kiraLife,false);assert.equal(budget,'maximum','manual adjustments preserve AI pause');
        assert.equal(catalog.inferActivityMode(preferences),'custom');
        await page.getByRole('radio',{name:'По моей инициативе',exact:true}).check();await save();await current('По моей инициативе');
        assert.ok(Object.values(preferences).every(value=>!value));assert.equal(budget,'normal');
        await open();await current('По моей инициативе');await page.setViewportSize({width:360,height:780});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        if(process.env.KIRA_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.KIRA_UI_SCREENSHOT_DIR,kind+'.png'),fullPage:true});
        const count=writes.length;failRead=true;await page.goto(url);if(kind==='portal')await page.getByRole('button',{name:'Настройки',exact:true}).click();
        await page.getByText(kind==='portal'?'Синтетическая ошибка чтения':'Не удалось загрузить функции. Повторите обновление.',{exact:true}).waitFor();
        assert.equal(writes.length,count);assert.deepEqual(errors,[]);
        console.log('Activity UI passed: '+kind+' drafts, preset, reload, failed write/retry, pause, custom, unavailable Telegram, mobile layout and read failure');
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}

async function main(){
  if(process.argv[2]==='--build-only'){await buildHarness(path.resolve(process.argv[3]));return;}
  const existing=process.env.KIRA_ADMIN_UI_FIXTURE_DIR;
  const scratch=existing?null:await fs.mkdtemp(path.join(os.tmpdir(),'kira-activity-ui-'));
  try{const harness=existing||scratch;if(!existing)await buildHarness(harness);await run(harness);}
  finally{if(scratch)await fs.rm(scratch,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
