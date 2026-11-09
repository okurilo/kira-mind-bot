import { deflateSync } from 'node:zlib';
import { validateUiPayload, safeUiUrl } from './validate';
import type { UiAction, UiComponent, UiInput, UiPayload } from './contracts';
import { utcDate } from './forms';

/** Telegram profile 1: fixed, trusted code; never execute model-produced HTML/JS. */
export const TELEGRAM_WIDGET_LIMITS = { html: 32768, compressed: 3800, units: 100, url: 256 } as const;
export type WidgetValue = number | null;
export interface WidgetState { r: number; v: WidgetValue[]; done?: boolean; n?: string }
export interface RenderedTelegramWidget { html: string; fields: UiInput[]; state: WidgetState }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const input = (c: UiComponent): c is UiInput => ['Choice', 'Slider', 'Toggle', 'DateTime'].includes(c.component);
export function initialWidgetValue(f: UiInput): WidgetValue {
    if (f.component === 'Choice') return f.value === undefined ? null : f.options.findIndex(o => o.value === f.value);
    if (f.component === 'Slider') return Math.round((f.value - f.min) / f.step);
    if (f.component === 'Toggle') return Number(f.value);
    return f.value ? Date.parse(f.value) : null;
}
export function widgetValue(f: UiInput, value: WidgetValue): string | number | boolean | undefined {
    if (value === null) return undefined;
    if (!Number.isSafeInteger(value)) throw Error('invalid_widget_value');
    if (f.component === 'Choice') { if (!f.options[value]) throw Error('invalid_widget_choice'); return f.options[value].value; }
    if (f.component === 'Slider') {
        const v = Number((f.min + value * f.step).toPrecision(15));
        if (value < 0 || v < f.min || v > f.max) throw Error('invalid_widget_slider'); return v;
    }
    if (f.component === 'Toggle') { if (value !== 0 && value !== 1) throw Error('invalid_widget_toggle'); return !!value; }
    const v = new Date(value).toISOString();
    if (!utcDate(v) || f.min && value < Date.parse(f.min) || f.max && value > Date.parse(f.max)) throw Error('invalid_widget_date');
    return v;
}

const STYLE = `body{margin:10px 12px;padding-bottom:16px;color:var(--tg-theme-text-color);font-size:15px;line-height:1.35}*{box-sizing:border-box}p,h3{margin:0}h3{font-size:18px;line-height:1.25;font-weight:700}[hidden]{display:none}button{min-height:40px;max-width:100%;white-space:normal;overflow-wrap:anywhere}section{padding:5px 0;overflow-wrap:anywhere}section[data-table]{padding:0}.metric{padding:10px;border-radius:12px;background:var(--tg-theme-secondary-bg-color)}.value{font-size:30px;line-height:1.25;font-weight:700;margin-top:4px}.metrics{display:flex;flex-wrap:wrap;gap:8px}.metrics>.metric{flex:1 1 110px;min-width:0}.hint,small{color:var(--tg-theme-hint-color);font-size:12px}.track{height:8px;background:var(--tg-theme-secondary-bg-color);border-radius:8px}.fill{height:8px;background:var(--tg-theme-accent-text-color);border-radius:8px}.pair{display:flex;gap:8px;flex-wrap:wrap}.pair>*{flex:1}table{width:100%;table-layout:fixed;border-collapse:collapse;margin:0;font-size:13px}td,th{overflow-wrap:anywhere;padding:7px 4px;text-align:left;border-bottom:1px solid var(--tg-theme-section-separator-color)}th{font-size:12px;color:var(--tg-theme-hint-color)}svg{width:100%;height:150px}#nav{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:6px}#status{font-size:12px;min-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}button[aria-pressed=true]{font-weight:bold;border:2px solid var(--tg-theme-accent-text-color)}`;

// No automatic requests. Every request/openLink happens synchronously inside a button click.
const SCRIPT = `const TW=window.TelegramWidget,$=id=>document.getElementById(id);let busy=false,page=0,pages=[],width=0;
function draw(){F.forEach((f,i)=>{let v=S.v[i],s=v===null?'Не выбрано':f.component==='Choice'?f.options[v].label:f.component==='Toggle'?(v?'Да':'Нет'):f.component==='Slider'?Number((f.min+v*f.step).toPrecision(15)):new Date(v).toISOString();$('v'+i).textContent=s;document.querySelectorAll('[data-choice="'+i+'"]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.value)===v)))});document.querySelectorAll('[data-query]').forEach(b=>b.disabled=busy||!!S.done);if(S.n)$('status').textContent=S.n;$('status').style.display=$('status').textContent?'block':'none';show()}
function show(){pages.forEach((p,i)=>p.forEach(e=>e.hidden=i!==page));$('nav').style.display=pages.length>1?'flex':'none';$('num').textContent=(page+1)+' / '+pages.length;$('prev').disabled=page===0;$('next').disabled=page===pages.length-1}
function layout(){const units=Array.from(document.querySelectorAll('main>section'));units.forEach(e=>e.hidden=false);pages=[[]];let h=0,last='',heads={};for(const e of units){const key=e.dataset.table||'',head=key?e.querySelector('thead'):null;if(head){head.hidden=false;if(heads[key]===undefined)heads[key]=head.getBoundingClientRect().height+2;head.hidden=last===key&&pages[pages.length-1].length>0}let n=e.getBoundingClientRect().height;if(h+n>430&&pages[pages.length-1].length){pages.push([]);h=0;if(head&&head.hidden){head.hidden=false;n+=heads[key]}}pages[pages.length-1].push(e);h+=n;last=key}page=Math.min(page,pages.length-1);show()}
function move(n){page+=n;show()}
function ask(data){if(!TW||busy||S.done)return;busy=true;$('status').textContent='Отправляю…';let p;try{p=TW.request(data)}catch(e){busy=false;$('status').textContent='Не отправлено';draw();return}draw();p.then(a=>{const d=JSON.parse(a.result);if(d.state)S=d.state;$('status').textContent=d.error|| (S.done?'Запрос принят':'')},()=>{$('status').textContent='Нет подтверждения. Проверь чат.'}).finally(()=>{busy=false;draw();layout()})}
function act(i){ask('a:'+S.r+':'+i)}
function pick(i,v){ask('f:'+S.r+':'+i+':'+v)}
function step(i,d){const f=F[i],v=S.v[i];if(v===null){if(f.component==='DateTime'&&f.min)pick(i,Date.parse(f.min));return}pick(i,v+d*(f.component==='DateTime'?900000:1))}
function link(i){if(TW)TW.openLink(L[i])}
function readState(){try{const s=JSON.parse(TW.chatData);if(s&&Number.isInteger(s.r)&&s.r>=S.r)S=s}catch(e){}}
function sync(){readState();draw();layout()}
function clock(){document.querySelectorAll('[data-until]').forEach(e=>{const m=Math.max(0,Math.ceil((Number(e.dataset.until)-Date.now())/60000));e.textContent=m?Math.floor(m/1440)+' д '+Math.floor(m%1440/60)+' ч '+m%60+' мин':'Время наступило'})}
if(TW)readState();draw();clock();layout();if(document.querySelector('[data-until]'))setInterval(clock,60000);if(typeof ResizeObserver==='function')new ResizeObserver(()=>{const w=document.body.getBoundingClientRect().width;if(w!==width){width=w;layout()}}).observe(document.body);if(TW){TW.onEvent('chatDataChanged',sync);TW.ready()}`;

export function renderTelegramWidget(ui: UiPayload): RenderedTelegramWidget | undefined {
    if (!validateUiPayload(ui, true)) return;
    const components = ui.messages[0].createSurface.components;
    const byId = new Map(components.map(c => [c.id, c]));
    const fields = components.filter(input), state: WidgetState = { r: 0, v: fields.map(initialWidgetValue) };
    // A keyboardless date control needs a grounded starting time. Do not invent one.
    if (fields.some(f => f.component === 'DateTime' && !f.value && !f.min)) return;
    const links: string[] = [], units: string[] = [], tables = new Set<string>();
    const unit = (s: string, table?: string) => units.push(`<section${table ? ` data-table="${table}"` : ''}>${s}</section>`);
    const metric = (c: Extract<UiComponent, { component: 'Metric' }>) => `<div class="metric"><small>${esc(c.label)}</small><div class="value">${esc(c.value)}</div>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</div>`;
    const text = (s: string, title = false) => {
        const chars = Array.from(s);
        for (let i = 0; i < chars.length; i += 120) unit(`<${title ? 'h3' : 'p'}>${esc(chars.slice(i, i + 120).join(''))}</${title ? 'h3' : 'p'}>`);
    };
    const urlButton = (url: string, label: string) => {
        if (!safeUiUrl(url) || url.length > TELEGRAM_WIDGET_LIMITS.url) throw Error('telegram_widget_url_too_long');
        return `<button onclick="link(${links.push(url) - 1})">${esc(label)}</button>`;
    };
    const actionButton = (action: UiAction, label: string) => {
        if (label.length > 200) throw Error('widget_button_too_large');
        if ('functionCall' in action) return urlButton(action.functionCall.args.url, label);
        // Tokens are opaque indices assigned by the Telegram adapter, never model text.
        const token = action.event.context.actionToken;
        if (!/^w\d{1,2}$/.test(token)) throw Error('invalid_widget_action');
        return `<button data-query onclick="act(${Number(token.slice(1))})">${esc(label)}</button>`;
    };
    function walk(id: string): void {
        const c = byId.get(id)!;
        switch (c.component) {
            case 'Column': c.children.forEach(walk); break;
            case 'Row': {
                const children = c.children.map(child => byId.get(child)!);
                if (children.length === 2 && children.every((child): child is Extract<UiComponent, { component: 'Metric' }> => child.component === 'Metric'
                    && child.label.length <= 24 && child.value.length <= 10 && !child.detail)) unit(`<div class="metrics">${children.map(metric).join('')}</div>`);
                else c.children.forEach(walk);
                break;
            }
            case 'Card': walk(c.child); break;
            case 'Text': text(c.text, c.variant === 'title'); break;
            case 'Divider': unit('<hr>'); break;
            case 'Metric':
                if (c.value.length > 24 || (c.label + (c.detail ?? '')).length > 96) { text(c.label, true); text(c.value); if (c.detail) text(c.detail); break; }
                if ((c.label + c.value + (c.detail ?? '')).length > 400) throw Error('metric_too_large');
                unit(metric(c)); break;
            case 'Button': {
                const label = byId.get(c.child); if (label?.component !== 'Text') throw Error('invalid_button_child');
                unit(actionButton(c.action, label.text)); break;
            }
            case 'Table': {
                if (c.columns.length <= 3 && [...c.columns, ...c.rows.flat()].every(v => v.length <= 32)) {
                    tables.add(c.id);
                    for (let i = 0; i < c.rows.length; i += 2) unit(`<table><thead><tr>${c.columns.map(s => `<th>${esc(s)}</th>`).join('')}</tr></thead><tbody>${c.rows.slice(i, i + 2).map(row => `<tr>${row.map(s => `<td>${esc(s)}</td>`).join('')}</tr>`).join('')}</tbody></table>`, c.id);
                } else c.rows.forEach((row, i) => { text(`Строка ${i + 1}`, true); row.forEach((s, j) => text(`${c.columns[j]}: ${s}`)); });
                break;
            }
            case 'Chart': {
                const all = c.series.flatMap(s => s.values), min = Math.min(0, ...all), max = Math.max(...all), span = max - min || 1;
                const x = (i: number) => 8 + i * 284 / Math.max(1, c.labels.length - 1);
                const y = (v: number) => 140 - (v - min) * 130 / span;
                let paths: string;
                if (c.kind === 'donut') {
                    const values = c.series[0].values, total = values.reduce((a, b) => a + b, 0); let offset = 0;
                    paths = values.map((v, i) => { const pct = v / total * 100, start = offset; offset += pct;
                        return `<circle cx="150" cy="75" r="48" fill="none" stroke="var(--tg-theme-accent-text-color)" stroke-opacity="${1 - i % 4 * .18}" stroke-width="22" pathLength="100" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${-start}" transform="rotate(-90 150 75)"/>`; }).join('');
                } else paths = c.series.map((s, j) => c.kind === 'line'
                    ? `<polyline fill="none" stroke="var(--tg-theme-accent-text-color)" stroke-width="${2 + j}" stroke-dasharray="${j ? '4 3' : 'none'}" points="${s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`
                    : s.values.map((v, i) => `<rect x="${8 + i * 284 / c.labels.length + j * 284 / c.labels.length / c.series.length}" y="${Math.min(y(v), y(0))}" width="${Math.max(1, 284 / c.labels.length / c.series.length - 2)}" height="${Math.abs(y(v) - y(0))}" fill="var(--tg-theme-accent-text-color)" fill-opacity="${1 - j * .2}"/>`).join('')).join('');
                unit(`<svg viewBox="0 0 300 150" role="img" aria-label="${esc(c.series.map(s => s.label).join(', '))}">${paths}</svg>`);
                c.series.forEach(s => { text(s.label + (c.unit ? ` (${c.unit})` : ''), true); for (let i = 0; i < c.labels.length; i += 3) text(c.labels.slice(i, i + 3).map((label, j) => `${label}: ${s.values[i + j]}`).join(' · ')); }); break;
            }
            case 'Progress': unit(`<p>${esc(c.label)} · ${Math.round(c.value * 100)}%</p><div class="track"><div class="fill" style="width:${c.value * 100}%"></div></div>`); if (c.detail) text(c.detail); break;
            case 'Steps': c.items.forEach((s, i) => text(`${s.state === 'done' ? '✓' : s.state === 'current' ? '→' : '○'} ${i + 1}. ${s.label}${s.detail ? ' — ' + s.detail : ''}`)); break;
            case 'Checklist': c.items.forEach(s => { if (s.actionToken) unit(actionButton({ event: { name: 'kira.action', context: { actionToken: s.actionToken } } }, `${s.checked ? '☑' : '☐'} ${s.label}`)); else text(`${s.checked ? '☑' : '☐'} ${s.label}`); }); break;
            case 'Map': c.pins.forEach(p => { text(`${p.label}: ${p.lat}, ${p.lon}`); unit(urlButton(`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=15/${p.lat}/${p.lon}`, 'Открыть карту')); }); break;
            case 'Image': text(c.alt); break; // Files remain attachments; no authenticated network fetch in the sandbox.
            case 'Countdown': text(`${c.label}: ${c.until}`); unit(`<b data-until="${Date.parse(c.until)}"></b>`); break;
            case 'Choice': case 'Slider': case 'Toggle': case 'DateTime': {
                const i = fields.findIndex(f => f.id === c.id);
                unit(`<b>${esc(c.label)}</b><p id="v${i}"></p>`);
                if (c.component === 'Choice') c.options.forEach((o, j) => unit(`<button data-query data-choice="${i}" data-value="${j}" onclick="pick(${i},${j})">${esc(o.label)}</button>`));
                else if (c.component === 'Toggle') unit(`<div class="pair"><button data-query onclick="pick(${i},1)">Да</button><button data-query onclick="pick(${i},0)">Нет</button></div>`);
                else unit(`<div class="pair"><button data-query onclick="step(${i},-1)">−${c.component === 'DateTime' ? '15 мин' : c.step}</button><button data-query onclick="step(${i},1)">+${c.component === 'DateTime' ? '15 мин' : c.step}</button></div>`);
                break;
            }
        }
    }
    try {
        if (ui.meta?.title && !components.some(c => c.component === 'Text' && c.variant === 'title' && c.text === ui.meta!.title)) text(ui.meta.title, true);
        walk('root');
        if (ui.meta?.asOf) text(`Данные на ${ui.meta.asOf}`);
        ui.meta?.sources?.forEach(s => unit(urlButton(s.url, s.label)));
        if (!units.length || units.length > TELEGRAM_WIDGET_LIMITS.units || units.length + tables.size > 120) return;
        const html = `<!doctype html><html><head><style>${STYLE}</style></head><body><main>${units.join('')}</main><nav id="nav"><button id="prev" aria-label="Предыдущая страница" onclick="move(-1)">←</button><small id="num"></small><button id="next" aria-label="Следующая страница" onclick="move(1)">→</button></nav><p id="status" role="status"></p><script>const F=${json(fields)},L=${json(links)};let S=${json(state)};${SCRIPT}</script></body></html>`;
        if (html.includes('\0') || Buffer.byteLength(html) > TELEGRAM_WIDGET_LIMITS.html || deflateSync(html, { level: 9 }).length > TELEGRAM_WIDGET_LIMITS.compressed) return;
        return { html, fields, state };
    } catch { return; }
}
