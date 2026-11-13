'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { registerClient, startAuthorization, exchangeAuthorization } = require('@modelcontextprotocol/sdk/client/auth.js');
const { parseMcpConfig, assertSafeMcpValue, PLAUD_MCP_URL, PLAUD_READ_TOOLS } = require('../utils/mcpConfig');
const { connectMcp, McpHttpError, secretHeaderValues, PLAUD_ORIGIN, PLAUD_OAUTH, plaudFetch, plaudCredentials,
  writePlaudCredentials, plaudDirectory, bindPlaudGrant } = require('../utils/mcpConnection');

const MONEY_MAKER_TOOLS = ['get_candles', 'get_price_summary', 'get_indicator', 'list_available_indicators',
  'get_technical_decision_brief', 'get_market_trap_context', 'get_market_regime', 'search_news', 'get_news_decision_brief',
  'get_news_impulse_signal', 'get_company_report', 'get_investment_events_calendar'];
const TEMPLATES = [{ id: 'custom', name: 'Свой MCP-сервер', config: { description: '', transport: 'http', url: '', tools: {}, timeoutMs: 30000 } },
  { id: 'money-maker', name: 'Money Maker', config: {
    description: 'Money Maker: аналитика рынка и акций, новости с доступными текстами, отчётность, индикаторы и календарь событий. Доступные инструменты и параметры определяются актуальным каталогом MCP.',
    transport: 'jsonrpc', url: '', headers: { Authorization: '' }, fixedArguments: { responseMode: 'full' }, timeoutMs: 60000,
    tools: Object.fromEntries(MONEY_MAKER_TOOLS.map(name => [name, 'read'])) } }];
class McpSettingsError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validId = id => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id);

async function mcpSettingsFile(root, accountMode = false) {
  if (!accountMode) return path.join(root, 'mcp.json');
  // A trusted migration binding, never an account/path supplied through HTTP.
  let state;
  try { state = JSON.parse(await fs.readFile(path.join(root, 'accounts/import/current-account.json'), 'utf8')); }
  catch { throw new McpSettingsError('Не найдено подключение админки к аккаунту. Проверь локальную миграцию.', 503); }
  if (state.phase !== 'active' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.accountId)) throw new McpSettingsError('Некорректное подключение админки к аккаунту.', 503);
  return path.join(root, 'accounts', `kira_u_${state.accountId.replaceAll('-', '')}`, 'data/mcp.json');
}

async function readSettings(file) {
  let text;
  try {
    const stat = await fs.stat(file);
    if (stat.size > 128000) throw new Error();
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') text = '{"servers":{}}';
    else throw new McpSettingsError('Не удалось прочитать файл MCP.', 500);
  }
  try { const value = JSON.parse(text); parseMcpConfig(value); return { value, revision: digest(text) }; }
  catch { throw new McpSettingsError('Файл MCP повреждён. Существующие подключения не изменены.', 500); }
}

function publicConfig(server) {
  const masked = { ...server, timeoutMs: server.timeoutMs ?? 30000 };
  if (server.plaudGrant) masked.plaudGrant = null;
  for (const field of ['headers', 'env']) if (server[field]) masked[field] = Object.fromEntries(Object.keys(server[field]).map(key => [key, null]));
  if (server.oauth) masked.oauth = { ...server.oauth, clientSecret: null };
  return masked;
}
function publicSettings(snapshot) {
  return { revision: snapshot.revision, servers: Object.entries(snapshot.value.servers).map(([id, config]) => ({ id, config: publicConfig(config) })), templates: TEMPLATES };
}

function connectionFromDraft(snapshot, id, draft, newGrant) {
  if (!validId(id) || !object(draft) || Object.keys(draft).some(key => !['config', 'revision'].includes(key)) || !object(draft.config)) throw new McpSettingsError('Некорректные поля подключения.');
  const previous = snapshot.value.servers[id];
  const config = structuredClone(draft.config);
  try { assertSafeMcpValue(config); } catch { throw new McpSettingsError('Недопустимые поля подключения.'); }
  const sameTarget = previous && previous.transport === config.transport && (config.transport === 'stdio'
    ? previous.command === config.command && JSON.stringify(previous.args ?? []) === JSON.stringify(config.args ?? [])
    : previous.url === config.url);
  if (newGrant) config.plaudGrant = newGrant;
  else if (config.plaudGrant === null && sameTarget && previous.plaudGrant) config.plaudGrant = previous.plaudGrant;
  else if (config.plaudGrant !== undefined || previous?.plaudGrant) throw new McpSettingsError('Измени доступ Plaud через вход в браузере.');
  // Null retains a secret, omitted keys remove it. Never forward retained credentials to a changed target.
  for (const field of ['headers', 'env']) if (object(config[field])) for (const [key, value] of Object.entries(config[field])) {
    if (value !== null) continue;
    if (!sameTarget || typeof previous?.[field]?.[key] !== 'string') throw new McpSettingsError('При смене адреса, транспорта или команды введи секреты заново.');
    config[field][key] = previous[field][key];
  }
  if (object(config.oauth) && config.oauth.clientSecret === null) {
    const sameClient = sameTarget && previous.oauth && ['tokenUrl', 'clientId', 'scope', 'audience'].every(key => previous.oauth[key] === config.oauth[key]);
    if (!sameClient) throw new McpSettingsError('При смене подключения OAuth введи client secret заново.');
    config.oauth.clientSecret = previous.oauth.clientSecret;
  }
  try { return parseMcpConfig({ servers: { [id]: config } })[id]; }
  catch (error) { throw new McpSettingsError(error.message); }
}

function createMcpSettingsStore(fileProvider) {
  let lane = Promise.resolve();
  const serial = operation => { const result = lane.then(operation, operation); lane = result.catch(() => {}); return result; };
  const snapshotFor = async draft => {
    const file = await fileProvider(); const snapshot = await readSettings(file);
    if (draft?.revision !== snapshot.revision) throw new McpSettingsError('Подключения уже изменились. Обнови настройки перед сохранением.', 409);
    return { file, snapshot };
  };
  return {
    async get() { return publicSettings(await readSettings(await fileProvider())); },
    async draft(id, draft) {
      const { snapshot, file } = await snapshotFor(draft);
      return bindPlaudGrant(connectionFromDraft(snapshot, id, draft), file);
    },
    async plaudTarget(revision) {
      const { snapshot, file } = await snapshotFor({ revision });
      const previous = snapshot.value.servers.plaud;
      if (previous && !previous.plaudGrant) throw new McpSettingsError('ID plaud уже занят другим подключением.', 409);
      if (!previous && Object.keys(snapshot.value.servers).length >= 16) throw new McpSettingsError('Достигнут лимит MCP-серверов.', 409);
      return { file, previous };
    },
    save(id, draft, mode = 'update', authorization) { return serial(async () => {
      if (!validId(id)) throw new McpSettingsError('ID сервера: латинская буква, затем буквы, цифры, дефис или подчёркивание, до 64 символов.');
      const { file, snapshot } = await snapshotFor(draft);
      if (authorization && file !== authorization.file) throw new McpSettingsError('Аккаунт Эни изменился. Подключи Plaud заново.', 409);
      const oldGrant = snapshot.value.servers[id]?.plaudGrant;
      const exists = Object.hasOwn(snapshot.value.servers, id);
      if (mode === 'create' && exists) throw new McpSettingsError('Сервер с таким ID уже подключён.', 409);
      if (mode !== 'create' && !exists) throw new McpSettingsError('Подключение не найдено.', 404);
      if (mode === 'delete') {
        if (!object(draft) || Object.keys(draft).some(key => key !== 'revision')) throw new McpSettingsError('Некорректные поля удаления.');
        delete snapshot.value.servers[id];
      } else snapshot.value.servers[id] = connectionFromDraft(snapshot, id, draft, authorization?.grant);
      try { parseMcpConfig(snapshot.value); } catch (error) { throw new McpSettingsError(error.message); }
      const contents = JSON.stringify(snapshot.value, null, 2);
      if (Buffer.byteLength(contents) > 128000) throw new McpSettingsError('Конфигурация MCP слишком велика.');
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
        if ((await readSettings(file)).revision !== snapshot.revision) throw new McpSettingsError('Файл MCP изменился во время сохранения. Обнови настройки.', 409);
        await fs.rename(temp, file);
      } finally { await fs.unlink(temp).catch(() => {}); }
      if (oldGrant && (mode === 'delete' || authorization)) await fs.rm(plaudDirectory(file, oldGrant), { recursive: true, force: true }).catch(() => {});
      return publicSettings({ value: snapshot.value, revision: digest(contents) });
    }); },
  };
}

function plaudRedirect(req) {
  let origin;
  try { origin = new URL(req.headers.origin); } catch { throw new McpSettingsError('Открой панель Эни в браузере.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  const publicOrigin = req.operatorPublicOrigin;
  if (origin.origin !== req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site'
      || (publicOrigin ? origin.origin !== publicOrigin : origin.host !== req.headers.host)
      || !(origin.protocol === 'https:' || loopback && origin.protocol === 'http:')) {
    throw new McpSettingsError('Для входа в Plaud открой панель по HTTPS или через localhost.', 403);
  }
  return origin.origin + (publicOrigin ? '/operator/' : '/');
}

function registerPlaudRoutes(app, requireAuth, route, store, probe) {
  const pending = new Map();
  app.post('/api/mcp/plaud/start', requireAuth, route(async req => {
    const redirectUri = plaudRedirect(req);
    const revision = req.body?.revision;
    const { file } = await store.plaudTarget(revision);
    for (const [session, flow] of pending) if (flow.until <= Date.now()) pending.delete(session);
    if (pending.size >= 32 && !pending.has(req.sessionID)) throw new McpSettingsError('Повтори вход в Plaud позже.', 429);
    const flow = { revision, file, redirectUri, state: crypto.randomBytes(32).toString('base64url'), until: Date.now() + 10 * 60_000 };
    pending.set(req.sessionID, flow);
    try {
      const { client_id: clientId } = await registerClient(PLAUD_ORIGIN, { metadata: PLAUD_OAUTH, fetchFn: plaudFetch(AbortSignal.timeout(10_000)),
        clientMetadata: { client_name: 'Enya', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'], token_endpoint_auth_method: 'none' } });
      const { authorizationUrl, codeVerifier } = await startAuthorization(PLAUD_ORIGIN, { metadata: PLAUD_OAUTH,
        clientInformation: { client_id: clientId }, redirectUrl: redirectUri, state: flow.state, resource: new URL(PLAUD_MCP_URL) });
      Object.assign(flow, { clientId, codeVerifier });
      return { url: authorizationUrl.href };
    } catch {
      if (pending.get(req.sessionID) === flow) pending.delete(req.sessionID);
      throw new McpSettingsError('Plaud не открыл вход. Попробуй подключиться ещё раз.', 502);
    }
  }));
  app.post('/api/mcp/plaud/finish', requireAuth, route(async req => {
    const flow = pending.get(req.sessionID);
    const { state, code } = req.body ?? {};
    if (!flow?.codeVerifier || flow.until <= Date.now() || state !== flow.state || plaudRedirect(req) !== flow.redirectUri) {
      throw new McpSettingsError('Запрос на вход в Plaud истёк. Начни подключение заново.', 409);
    }
    pending.delete(req.sessionID);
    if (typeof code !== 'string' || !code || code.length > 4096) throw new McpSettingsError('Доступ к записям Plaud не выдан.');
    const { file, previous } = await store.plaudTarget(flow.revision);
    if (file !== flow.file) throw new McpSettingsError('Аккаунт Эни изменился. Подключи Plaud заново.', 409);
    const grant = crypto.randomBytes(16).toString('hex');
    const directory = plaudDirectory(file, grant);
    let credentials;
    try {
      const tokens = await exchangeAuthorization(PLAUD_ORIGIN, { metadata: PLAUD_OAUTH, clientInformation: { client_id: flow.clientId },
        authorizationCode: code, codeVerifier: flow.codeVerifier, redirectUri: flow.redirectUri, resource: new URL(PLAUD_MCP_URL),
        fetchFn: plaudFetch(AbortSignal.timeout(10_000)) });
      credentials = plaudCredentials(flow.clientId, tokens);
    } catch { throw new McpSettingsError('Plaud не подтвердил вход. Подключи Plaud заново.', 502); }
    const config = { ...previous, description: previous?.description ?? 'Plaud: поиск записей встреч и звонков, расшифровки и резюме.',
      transport: 'http', url: PLAUD_MCP_URL, tools: {}, plaudGrant: grant, timeoutMs: previous?.timeoutMs ?? 30000 };
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let committed = false;
    try {
      await writePlaudCredentials(directory, credentials);
      const catalog = await probe(bindPlaudGrant(config, file));
      const tools = PLAUD_READ_TOOLS.filter(name => catalog.tools.some(tool => tool.name === name));
      if (!tools.length) throw new McpSettingsError('Plaud MCP не предоставил инструменты чтения.', 502);
      config.tools = Object.fromEntries(tools.filter(name => !previous || previous.tools[name] === 'read').map(name => [name, 'read']));
      const saved = await store.save('plaud', { revision: flow.revision, config }, previous ? 'update' : 'create', { file, grant });
      committed = true;
      return saved;
    } finally { if (!committed) await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
  }));
}

async function probeMcp(server, connector = connectMcp) {
  const signal = AbortSignal.timeout(Math.min(15000, server.timeoutMs));
  let connection;
  try {
    connection = await connector(server, signal);
    const secrets = [...secretHeaderValues(server.headers ?? {}), ...Object.values(server.env ?? {}), server.oauth?.clientSecret ?? '', ...(connection.secrets ?? [])]
      .flatMap(value => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')]).filter(Boolean);
    const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[секрет скрыт]'), String(value));
    const tools = []; const seen = new Set(); const names = new Set(); let cursor; let truncated = false;
    const capabilities = connection.client.getServerCapabilities() ?? {};
    if (capabilities.tools) for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const page = await connection.client.listTools(cursor ? { cursor } : {}, { signal, timeout: server.timeoutMs });
      for (const tool of page.tools) {
        if (names.has(tool.name)) continue;
        if (tools.length >= 200) { truncated = true; break; }
        names.add(tool.name);
        tools.push({ name: redact(tool.name), description: redact(tool.description ?? '').slice(0, 600) });
      }
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor) || pageIndex === 9 || truncated) { truncated = true; break; }
      cursor = page.nextCursor; seen.add(cursor);
    }
    const visible = server.plaudGrant ? tools.filter(tool => PLAUD_READ_TOOLS.includes(tool.name)) : tools;
    return { success: true, tools: visible, toolCount: visible.length, truncated, resources: Boolean(capabilities.resources) };
  } catch (error) {
    if (server.plaudGrant && (error?.status === 401 || error?.message?.startsWith('Plaud MCP:'))) throw new McpSettingsError('Не удалось подтвердить доступ к Plaud. Нажми «Войти заново» в подключениях.', 502);
    if (error instanceof McpHttpError) throw new McpSettingsError(`MCP: HTTP ${error.status}. Проверь доступ к серверу и авторизацию.`, 502);
    throw new McpSettingsError('Не удалось проверить MCP. Проверь адрес, транспорт и авторизацию.', 502);
  } finally { await connection?.close().catch(() => {}); }
}

function registerMcpRoutes(app, { requireAuth, runtimeDir, accountMode = false, probe = probeMcp }) {
  const store = createMcpSettingsStore(() => mcpSettingsFile(runtimeDir, accountMode));
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await handler(req)); }
    catch (error) { res.status(error instanceof McpSettingsError ? error.status : 500).json({ error: error instanceof McpSettingsError ? error.message : 'Не удалось выполнить операцию MCP. Credentials скрыты.' }); }
  };
  app.get('/api/mcp/servers', requireAuth, route(() => store.get()));
  app.post('/api/mcp/servers/:id', requireAuth, route(req => store.save(req.params.id, req.body, 'create')));
  app.put('/api/mcp/servers/:id', requireAuth, route(req => store.save(req.params.id, req.body)));
  app.delete('/api/mcp/servers/:id', requireAuth, route(req => store.save(req.params.id, req.body, 'delete')));
  app.post('/api/mcp/servers/:id/check', requireAuth, route(async req => probe(await store.draft(req.params.id, req.body))));
  registerPlaudRoutes(app, requireAuth, route, store, probe);
}
module.exports = { MONEY_MAKER_TOOLS, McpSettingsError, mcpSettingsFile, publicSettings, connectionFromDraft, createMcpSettingsStore, probeMcp, registerMcpRoutes };
