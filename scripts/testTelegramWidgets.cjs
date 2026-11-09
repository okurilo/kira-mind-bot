'use strict';
// Synthetic, offline DOM/bridge check. This does not claim to emulate Telegram's native QuickJS renderer.
const assert = require('node:assert/strict');
Object.assign(process.env, { NODE_ENV: 'test', KIRA_BOT_TOKEN: '1234567890:abcdefghijklmnopqrstuvwxyzABCDE', OPENAI_API_KEY: 'test' });
const { chromium } = require('playwright');
const { compileUi } = require('../dist/generative-ui/validate');
const { renderTelegramWidget } = require('../dist/generative-ui/telegramRender');
const { TelegramUiService } = require('../dist/generative-ui/telegram');
const { MemoryUiStore } = require('../dist/tests/helpers/generativeUi');
const owner = 730001;
const malicious = '</script><script>window.exploited=true</script>';
const draft = { components: [
  { id:'root',component:'Column',children:['title','metric','table','chart','choice','slider','toggle','date','button'] },
  { id:'title',component:'Text',variant:'title',text:'Синтетическая карточка' },
  { id:'metric',component:'Metric',label:'Учебная температура',value:'18 °C' },
  { id:'table',component:'Table',columns:['День','°C'],rows:Array.from({length:24},(_,i)=>['День '+i,String(18+i)]) },
  { id:'chart',component:'Chart',kind:'bar',labels:['А','Б'],series:[{label:'Учебный ряд',values:[18,20]}] },
  { id:'choice',component:'Choice',label:'Занятие',options:[{value:'read',label:'Чтение'},{value:'walk',label:'Прогулка'}] },
  { id:'slider',component:'Slider',label:'Минуты',min:10,max:60,step:5,value:20 },
  { id:'toggle',component:'Toggle',label:'Разминка',value:true },
  { id:'date',component:'DateTime',label:'Когда',value:'2041-04-12T19:00:00Z' },
  { id:'button',component:'Button',child:'label',action:{type:'submit',text:'Составь план',fields:['choice','slider','toggle','date']} },
  { id:'label',component:'Text',text:'Составить план' },
] };
async function run() {
  const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']});
  try {
    for (const width of [200,320,430,600]) for (const dark of [false,true]) {
      const store = new MemoryUiStore(); await store.transact(owner,tx=>tx.put('canonical','turn','tg:1'));
      const service = new TelegramUiService(store,async()=>JSON.stringify(draft));
      let payload;
      await service.deliver(owner,{sendWidget:async p=>{payload=p;return {message_id:20}}},'Покажи учебный план','Учебный план 18 °C. Время 2041-04-12T19:00:00Z.',10,undefined,'tg:1');
      assert.ok(payload,'Fixture must fit Telegram byte limits');
      const page = await browser.newPage({viewport:{width,height:800},colorScheme:dark?'dark':'light'});
      const errors=[],queries=[],dispatches=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>route.abort());
      await page.exposeFunction('widgetQuery',async data=>{
        queries.push(data);assert.ok(Buffer.byteLength(data)<=64);
        const r=await service.query(owner,{id:'synthetic-'+queries.length,from:{id:owner,is_bot:false},chat:{id:owner,type:'private'},message_id:20,type:{type:'data'},data});
        if(r.dispatch)dispatches.push(r.dispatch);
        return {result:JSON.stringify({state:r.state,error:r.error})};
      });
      const palette = `:root{--tg-theme-bg-color:${dark?'#18222d':'#ffffff'};--tg-theme-text-color:${dark?'#ffffff':'#18222d'};--tg-theme-hint-color:${dark?'#aabbcc':'#556677'};--tg-theme-accent-text-color:${dark?'#80caff':'#1263a0'};--tg-theme-secondary-bg-color:${dark?'#26384a':'#eef4f9'}}body{background:var(--tg-theme-bg-color)}`;
      const shim = `<script>window.TelegramWidget={chatData:${JSON.stringify(payload.chat_data)},request:data=>window.widgetQuery(data),onEvent:(_n,f)=>window.syncData=f,ready:()=>{},openLink:()=>{}}</script>`;
      await page.setContent(payload.html.replace('<head>','<head><style>'+palette+'</style>'+shim));
      await page.waitForTimeout(60); assert.equal(queries.length,0,'No automatic action requests');
      async function checkPage() {
        const dimensions = await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.body.getBoundingClientRect().height}));
        assert.ok(dimensions.width<=width,JSON.stringify({width,dark,dimensions}));
        assert.ok(dimensions.height<=560,JSON.stringify({width,dark,dimensions}));
      }
      const pages = Number((await page.locator('#num').textContent()).split('/')[1]);assert.ok(pages>1);
      for(let p=0;p<pages;p++){await checkPage();if(p<pages-1)await page.locator('#next').click()}
      async function clickLabel(label) {
        for(let p=0;p<pages;p++){if(await page.getByRole('button',{name:label,exact:true}).isVisible()){await page.getByRole('button',{name:label,exact:true}).click();return}if(await page.locator('#prev').isEnabled())await page.locator('#prev').click()}
        for(let p=0;p<pages;p++){if(await page.getByRole('button',{name:label,exact:true}).isVisible()){await page.getByRole('button',{name:label,exact:true}).click();return}if(await page.locator('#next').isEnabled())await page.locator('#next').click()}
        assert.fail('Missing button: '+label);
      }
      await clickLabel('Прогулка');await page.waitForFunction(()=>document.getElementById('status').textContent==='');
      await clickLabel('Составить план');await page.waitForFunction(()=>document.getElementById('status').textContent==='Запрос принят');
      assert.equal(dispatches.length,1);assert.match(dispatches[0].action.text,/Занятие: Прогулка/);
      assert.equal(await page.locator('[data-query]:enabled').count(),0); assert.deepEqual(errors,[]);
      await page.evaluate(()=>{const s=JSON.parse(window.TelegramWidget.chatData);s.r=99;s.done=true;s.n='W'.repeat(160);window.TelegramWidget.chatData=JSON.stringify(s);window.syncData()});await checkPage();
      assert.equal(await page.locator('#status').textContent(),'W'.repeat(160));
      const hostile=compileUi({components:[{id:'root',component:'Text',text:malicious}]},{urls:new Set(),actions:[],replyToken:()=> 'w0'},{enabled:true,catalogId:'urn:kira:ui:catalog:2'});
      await page.goto('about:blank');await page.setContent(renderTelegramWidget(hostile).html);assert.equal(await page.evaluate(()=>window.exploited),undefined);assert.deepEqual(errors,[]);
      const wide=compileUi({components:[{id:'root',component:'Column',children:['title','metric','table']},
        {id:'title',component:'Text',variant:'title',text:'😀'.repeat(120)},
        {id:'metric',component:'Metric',label:'W'.repeat(160),value:'W'.repeat(128),detail:'W'.repeat(500)},
        {id:'table',component:'Table',columns:['W'.repeat(32),'W'.repeat(32),'W'.repeat(32)],rows:Array.from({length:3},()=>['W'.repeat(32),'W'.repeat(32),'W'.repeat(32)])}]},
        {urls:new Set(),actions:[],replyToken:()=> 'w0'},{enabled:true,catalogId:'urn:kira:ui:catalog:2'});
      await page.goto('about:blank');await page.setContent(renderTelegramWidget(wide).html);
      const widePages=Number((await page.locator('#num').textContent()).split('/')[1]);
      for(let p=0;p<widePages;p++){await checkPage();if(p<widePages-1)await page.locator('#next').click()}
      assert.deepEqual(errors,[]);
      await page.close();
    }
    console.log('Telegram widget DOM checks passed: 4 widths × 2 themes, pagination, offline bridge, form submit, hostile text.');
  } finally {await browser.close()}
}
run().catch(e=>{console.error(e);process.exitCode=1});
