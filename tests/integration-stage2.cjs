/**
 * Интеграционный тест этапа 2 (без Electron): фейковый Ollama-сервер
 * (NDJSON /api/chat) + РЕАЛЬНЫЕ AssistantService и ToolRegistry
 * (мокается только модуль 'electron' и зависимости main).
 *
 * Проверяет:
 *  1. двухшаговый цикл: model → tool_calls → исполнение тулa → результат
 *     (role:'tool') → model → финальный текст;
 *  2. карточка assistant:tool между пузырями; done-событие;
 *  3. fallback-парсер: tool call сырым JSON в content → исполнение +
 *     лог '[assistant] fallback-parser: parsed tool from content, name=…';
 *  4. меняющий тул (set_layout) реально вызывает manager.setLayout.
 *
 * Запуск: node tests/integration-stage2.cjs (после npm run build).
 */
const http = require('node:http');
const Module = require('node:module');

// --- мок 'electron' до первых require скомпилированных модулей ---
const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getVersion: () => '1.0.0-test',
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => '/tmp',
        on: () => {},
        whenReady: () => Promise.resolve(),
        commandLine: { appendSwitch: () => {} },
      },
      BrowserWindow: class {},
      session: { fromPartition: () => ({ setProxy: async () => {} }) },
      ipcMain: { handle: () => {}, on: () => {} },
    };
  }
  return origLoad.apply(this, arguments);
};

const { AssistantService } = require('../dist/main/ai/assistant');
const { ToolRegistry } = require('../dist/main/ai/tools/registry');

const PORT = 47831;
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

// --- сценарий фейкового сервера: что ответить на каждый POST /api/chat ---
let script = [];
let serverRequests = [];
function setScript(lines) {
  script = lines;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/api/chat')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    serverRequests.push(payload);
    const next = script.shift();
    if (!next) {
      res.writeHead(500).end('script exhausted');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const chunk of next) res.write(`${JSON.stringify(chunk)}\n`);
    res.end();
  });
});

// NDJSON-стрим: объявление → tool_calls → done
function turnToolCall(text, name, args) {
  return [
    { model: 'test-model', created_at: new Date().toISOString(), message: { role: 'assistant', content: text }, done: false },
    { model: 'test-model', created_at: new Date().toISOString(), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false },
    { model: 'test-model', created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
  ];
}

// NDJSON-стрим: финальный текст
function turnText(text) {
  return [
    { model: 'test-model', created_at: new Date().toISOString(), message: { role: 'assistant', content: text }, done: false },
    { model: 'test-model', created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
  ];
}

// NDJSON-стрим с content, содержащим сырой JSON тул-вызова (fallback)
function turnFallbackRaw(text) {
  return [
    { model: 'test-model', created_at: new Date().toISOString(), message: { role: 'assistant', content: text }, done: false },
    { model: 'test-model', created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
  ];
}

// --- заглушки зависимостей main ---
const state = {
  profiles: [
    {
      id: 'avito1', name: 'avito1', url: 'https://avito.ru', hasProxy: true,
      proxyScheme: 'http', proxyHost: 'proxy.example', extensions: [],
      timezone: 'Europe/Moscow', userAgentSet: false, platform: null,
      hardwareConcurrency: null, fingerprintSeed: null, locale: null,
      proxyRotation: null, visible: true,
    },
    {
      id: 'avito2', name: 'avito2', url: 'https://avito.ru', hasProxy: false,
      proxyScheme: null, proxyHost: null, extensions: [], timezone: null,
      userAgentSet: false, platform: null, hardwareConcurrency: null,
      fingerprintSeed: null, locale: null, proxyRotation: null, visible: true,
    },
  ],
  layout: '2x2', theme: 'dark', capacity: 4, logs: [], inputSync: false,
};
const calls = { setLayout: [], reloadView: [], rotate: 0, devtools: [] };
const manager = {
  getState: () => state,
  setLayout: (l) => {
    calls.setLayout.push(l);
    state.layout = l;
    return { ok: true };
  },
  reloadView: (id) => calls.reloadView.push(id),
  reloadAll: () => {},
  openDevTools: (id) => calls.devtools.push(id),
  reorderProfiles: async () => ({ ok: true }),
  setInputSync: async () => ({ ok: true }),
  rotateProxyNow: async (id) => {
    calls.rotate++;
    return { ok: true };
  },
};
const logLines = [];
const logger = {
  info: (m) => logLines.push(`[info] ${m}`),
  warn: (m) => logLines.push(`[warn] ${m}`),
  error: (m) => logLines.push(`[error] ${m}`),
};
const events = [];
const win = {
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => events.push({ channel, payload }) },
};
const configStub = {
  view: () => ({ mode: 'local', cloud: { endpoint: `http://127.0.0.1:${PORT}`, model: 'test-model' }, local: { endpoint: `http://127.0.0.1:${PORT}`, model: 'test-model' } }),
  getApiKey: () => ({ key: null }),
};
const tools = new ToolRegistry({
  manager,
  log: logger,
  activeProfileId: () => 'avito1',
  versions: () => ({ app: '1.0.0-test', electron: '33.4.11', chromium: '116', platform: 'linux x64' }),
});
const assistant = new AssistantService({
  log: logger,
  config: configStub,
  getWindow: () => win,
  buildContext: () => ({ state: manager.getState(), activeProfileId: 'avito1' }),
  tools,
});

async function scenario1() {
  console.log('\n=== Сценарий 1: двухшаговый цикл (list_profiles) ===');
  events.length = 0;
  serverRequests.length = 0;
  setScript([
    turnToolCall('Достаю список профилей.', 'list_profiles', {}),
    turnText('Два профиля: avito1 (через http-прокси) и avito2 (без прокси).'),
  ]);
  const res = await assistant.send('Сколько профилей?');
  check('send возвращает ok', res.ok, res);
  const toolEvents = events.filter((e) => e.channel === 'assistant:tool');
  check('карточка тулa пришла', toolEvents.length === 1 && toolEvents[0].payload.name === 'list_profiles', toolEvents.map((e) => e.payload));
  check('карточка успешна', toolEvents[0] && toolEvents[0].payload.ok === true, toolEvents[0]);
  check('заголовок карточки с числом', toolEvents[0] && /Профили: 2/.test(toolEvents[0].payload.title), toolEvents[0] && toolEvents[0].payload.title);
  const chunks = events.filter((e) => e.channel === 'assistant:chunk').map((e) => e.payload.delta).join('');
  check('стримился текст объявления', chunks.includes('Достаю список профилей.'), chunks);
  const done = events.find((e) => e.channel === 'assistant:done');
  check('done: провайдер local, модель', done && done.payload.provider === 'local' && done.payload.model === 'test-model', done);
  check('нет ошибок в UI', events.every((e) => e.channel !== 'assistant:error'), events.filter((e) => e.channel === 'assistant:error'));
  // Второй запрос должен содержать role:'tool' с текстом реального тула.
  const round2 = serverRequests[1];
  const toolMsg = round2 && round2.messages.find((m) => m.role === 'tool');
  check('раунд 2 получил role:tool', !!toolMsg, round2 && round2.messages.map((m) => m.role));
  check('текст тула — реальный список', toolMsg && toolMsg.content.includes('профилей: 2'), toolMsg && toolMsg.content);
  check('tool_name проставлен', toolMsg && toolMsg.tool_name === 'list_profiles', toolMsg);
  const asstMsg = round2 && round2.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  check('раунд 2 видит assistant+tool_calls', !!asstMsg, round2 && round2.messages);
}

async function scenario2() {
  console.log('\n=== Сценарий 2: fallback-парсер (grid_info сырым JSON в content) ===');
  events.length = 0;
  serverRequests.length = 0;
  setScript([
    turnFallbackRaw('Секунду, проверяю сетку.\n```json\n{"name":"grid_info","arguments":{}}\n```'),
    turnText('Сейчас раскладка 2x2: 4 ячейки, 2 профиля, оба в ячейках.'),
  ]);
  const res = await assistant.send('Какая раскладка?');
  check('send ok', res.ok, res);
  const toolEvents = events.filter((e) => e.channel === 'assistant:tool');
  check('fallback: тул исполнен', toolEvents.length === 1 && toolEvents[0].payload.name === 'grid_info', toolEvents.map((e) => e.payload));
  check(
    'лог fallback-parser присутствует',
    logLines.some((l) => l.includes('[assistant] fallback-parser: parsed tool from content, name=grid_info')),
    logLines.filter((l) => l.includes('fallback')),
  );
  // Пузырь перезапущен: restart + повторный chunk с чистым текстом (без JSON).
  const restarts = events.filter((e) => e.channel === 'assistant:restart');
  check('restart после fallback', restarts.length >= 1, restarts.length);
  // Пузырь по семантике renderer: restart стирает, chunk дописывает —
  // финальное состояние пузыря не должно содержать сырой JSON тул-вызова.
  let bubble = '';
  for (const e of events) {
    if (e.channel === 'assistant:restart') bubble = '';
    else if (e.channel === 'assistant:chunk') bubble += e.payload.delta;
  }
  check('JSON не попал в финальный текст пузыря', !bubble.includes('"name"') && !bubble.includes('```'), bubble);
  const done = events.find((e) => e.channel === 'assistant:done');
  check('done без ошибки', !!done && events.every((e) => e.channel !== 'assistant:error'), done);
}

async function scenario3() {
  console.log('\n=== Сценарий 3: меняющий тул set_layout (1x1) ===');
  events.length = 0;
  serverRequests.length = 0;
  setScript([
    turnToolCall('Переключаю на 1x1…', 'set_layout', { layout: '1x1' }),
    turnText('Готово: раскладка 1x1, обе страницы уместились в одну ячейку, вторая в фоне.'),
  ]);
  const res = await assistant.send('Переключи на 1x1');
  check('send ok', res.ok, res);
  check('manager.setLayout вызван с 1x1', calls.setLayout.includes('1x1'), calls.setLayout);
  const toolEvents = events.filter((e) => e.channel === 'assistant:tool');
  check('карточка set_layout', toolEvents.length === 1 && toolEvents[0].payload.name === 'set_layout', toolEvents.map((e) => e.payload));
  check('объявление стримится', events.filter((e) => e.channel === 'assistant:chunk').map((e) => e.payload.delta).join('').includes('Переключаю'), '');
  // round-2 запрос: model должна получить результат role:'tool' со сменой раскладки.
  const round2 = serverRequests[1];
  const toolMsg = round2 && round2.messages.find((m) => m.role === 'tool' && m.tool_name === 'set_layout');
  check('результат set_layout ушёл модели', toolMsg && toolMsg.content.includes('раскладка изменена'), toolMsg && toolMsg.content);
}

async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  try {
    await scenario1();
    await scenario2();
    await scenario3();
  } finally {
    server.close();
  }
  console.log(failures === 0 ? '\nINTEGRATION: все сценарии пройдены' : `\nINTEGRATION: провалено ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('INTEGRATION crash:', err);
  process.exit(1);
});
