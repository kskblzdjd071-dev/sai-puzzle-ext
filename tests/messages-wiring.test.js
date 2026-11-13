// 职责：验证网页游戏解谜扩展消息路由器各消息类型的接线行为，包括参数传递、响应形状与广播语义。
// 作者：Banana

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageRouter } from '../background/message-router.js';
import {
  createMessage,
  PING,
  PANEL_READY,
  SETTINGS_SAVE,
  SITES_ADD,
  SITES_REMOVE,
  PROVIDER_PERMISSION_REQUEST,
  CLUES_LIST,
  CLUES_EXPORT,
  CLUES_UPDATED,
  READER_DELTA,
  ACTIVE_TAB_INFO,
  AI_ASK,
} from '../core/messages.js';
import { createMemoryStorageAdapter } from '../adapters/storage.js';
import { createSettingsService } from '../core/settings.js';
import { createClueStore } from '../core/clues.js';

const TEST_API_KEY = 'sk-TESTONLY_not_a_real_key_xxxx9999';

const DEFAULT_EXTRACT_RESULT = {
  clues: [{ text: '铜钥匙', source: 'text', tags: ['道具'] }],
  model: 'gpt-4o',
};

const DEFAULT_ANSWER_RESULT = {
  summary: '已有线索',
  suggestions: ['再检查抽屉'],
  answer: '密码可能是 4312',
  model: 'gpt-4o',
};

async function setup(overrides = {}) {
  const storage = createMemoryStorageAdapter();

  const containsOrigin =
    overrides.containsOrigin ||
    (overrides.permissions && overrides.permissions.containsOrigin) ||
    (async () => true);

  const permissions = {
    requestOrigin: async () => true,
    removeOrigin: async () => true,
    containsOrigin,
    requestHost: async () => true,
    registerReader: () => {},
    unregisterReader: () => {},
    ...(overrides.permissions || {}),
    containsOrigin,
  };

  const settingsService = overrides.settingsService || createSettingsService({ storage, permissions });
  const clueStore = overrides.clueStore || createClueStore({ storage });

  const extractCalls = [];
  const answerCalls = [];
  const broadcasts = [];
  const sentTabs = [];

  const aiClient = overrides.aiClient || {
    extractClues(...args) {
      extractCalls.push(args);
      return overrides.extractResult || DEFAULT_EXTRACT_RESULT;
    },
    answerQuestion(question, clues) {
      answerCalls.push({ question, clues });
      return overrides.answerResult || DEFAULT_ANSWER_RESULT;
    },
  };

  const getActiveTab = overrides.getActiveTab || (async () => null);
  const getTabById = overrides.getTabById || (async () => null);
  const captureVisibleTab = overrides.captureVisibleTab || (async () => 'data:image/jpeg;base64,AAAA');
  const sendToTab = async (id, msg) => {
    sentTabs.push({ id, msg });
  };
  const broadcast = (msg) => {
    broadcasts.push(msg);
  };
  const now = overrides.now || Date.now;
  const screenshotThrottleMap = overrides.screenshotThrottleMap || new Map();
  const injectReadersIntoOpenTabs = overrides.injectReadersIntoOpenTabs;

  const router = createMessageRouter({
    settingsService,
    clueStore,
    aiClient,
    permissions,
    containsOrigin,
    getActiveTab,
    getTabById,
    captureVisibleTab,
    sendToTab,
    broadcast,
    now,
    screenshotThrottleMap,
    injectReadersIntoOpenTabs,
  });

  return { router, settingsService, clueStore, extractCalls, answerCalls, broadcasts, sentTabs, permissions };
}

function makeRecordingFakeSettings(overrides = {}) {
  return {
    getSettings: async () => ({ apiKey: '' }),
    getRedactedSettings: async () => ({ hasApiKey: false, apiKeyMasked: '' }),
    addGameSite: async () => ({ ok: true }),
    removeGameSite: async () => ({ ok: true }),
    requestProviderHostPermission: async () => true,
    ...overrides,
  };
}

test('SITES_ADD 以 origin 与 gameId 两参数调用 addGameSite', async () => {
  const addCalls = [];
  const fakeSettings = makeRecordingFakeSettings({
    addGameSite() {
      addCalls.push(arguments);
      return {
        site: { origin: 'https://game.example.com', gameId: 'room-1', enabled: true, granted: true, addedAt: 1 },
        granted: true,
      };
    },
  });

  const { router } = await setup({ settingsService: fakeSettings });

  const res = await router.handleMessage(
    createMessage(SITES_ADD, { origin: 'https://game.example.com', gameId: 'room-1' })
  );

  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0].length, 2);
  assert.equal(addCalls[0][0], 'https://game.example.com');
  assert.equal(addCalls[0][1], 'room-1');

  assert.equal(res.ok, true);
  assert.equal(res.payload.granted, true);
  assert.equal(typeof res.payload.site, 'object');
  assert.notEqual(res.payload.site, null);
});

test('SITES_REMOVE 以 origin 与 gameId 两参数调用 removeGameSite 并返回 { ok:true }', async () => {
  const removeCalls = [];
  const fakeSettings = makeRecordingFakeSettings({
    removeGameSite() {
      removeCalls.push(arguments);
      return { ok: true };
    },
  });

  const { router } = await setup({ settingsService: fakeSettings });

  const res = await router.handleMessage(
    createMessage(SITES_REMOVE, { origin: 'https://game.example.com', gameId: 'room-1' })
  );

  assert.equal(removeCalls.length, 1);
  assert.equal(removeCalls[0].length, 2);
  assert.equal(removeCalls[0][0], 'https://game.example.com');
  assert.equal(removeCalls[0][1], 'room-1');

  assert.equal(res.ok, true);
  assert.equal(res.payload.ok, true);
});

test('READER_DELTA 使用 payload.text 与 gameKey，广播 CLUES_UPDATED.addedCount', async () => {
  const fakeSettings = makeRecordingFakeSettings({
    getSettings: async () => ({ apiKey: TEST_API_KEY, model: 'gpt-4o', provider: 'openai_compatible' }),
  });

  const gameKey = 'https://game.example.com::room-1';

  const { router, broadcasts, extractCalls } = await setup({
    settingsService: fakeSettings,
    containsOrigin: async (origin) => origin === 'https://game.example.com',
  });

  await router.handleMessage(
    createMessage(READER_DELTA, {
      origin: 'https://game.example.com',
      gameKey,
      text: '出现一把铜钥匙',
      title: '谜题',
    })
  );

  assert.ok(extractCalls.length >= 1, 'extractClues 应至少被调用一次');
  assert.equal(extractCalls[0][0], '出现一把铜钥匙');

  const updated = broadcasts.find((m) => m && m.type === CLUES_UPDATED);
  assert.ok(updated, '应广播 CLUES_UPDATED');
  assert.equal(updated.payload.gameKey, gameKey);
  assert.equal(typeof updated.payload.addedCount, 'number');
  assert.ok(updated.payload.addedCount >= 1);
  assert.equal(Object.prototype.hasOwnProperty.call(updated.payload, 'clues'), false);
});

test('AI_ASK 按 gameKey 加载线索后调用 answerQuestion', async () => {
  const fakeSettings = makeRecordingFakeSettings({
    getSettings: async () => ({ apiKey: TEST_API_KEY, model: 'gpt-4o', provider: 'openai_compatible' }),
  });

  const gameKey = 'https://game.example.com::room-1';

  const { router, clueStore, answerCalls } = await setup({ settingsService: fakeSettings });

  await clueStore.addClues(gameKey, [{ text: '墙上写着 4312', source: 'text' }]);

  const res = await router.handleMessage(
    createMessage(AI_ASK, { gameKey, question: '密码是什么？' })
  );

  assert.equal(answerCalls.length, 1);
  assert.equal(answerCalls[0].question, '密码是什么？');
  assert.ok(Array.isArray(answerCalls[0].clues));
  assert.ok(answerCalls[0].clues.some((c) => c && typeof c.text === 'string' && c.text.includes('4312')));

  assert.equal(res.ok, true);
  assert.equal(typeof res.payload.summary, 'string');
  assert.equal(typeof res.payload.answer, 'string');
  assert.ok(Array.isArray(res.payload.suggestions));
});

test('SETTINGS_SAVE 响应 RedactedSettings 且不含明文 apiKey', async () => {
  const { router } = await setup();

  const res = await router.handleMessage(
    createMessage(SETTINGS_SAVE, {
      apiKey: TEST_API_KEY,
      model: 'gpt-4o',
      provider: 'openai_compatible',
    })
  );

  assert.equal(res.ok, true);
  assert.equal(res.payload.hasApiKey, true);
  assert.equal(typeof res.payload.apiKeyMasked, 'string');
  assert.notEqual(res.payload.apiKeyMasked, TEST_API_KEY);
  assert.equal(res.payload.apiKey, undefined);
  assert.equal(JSON.stringify(res.payload).includes(TEST_API_KEY), false);
});

test('PING 返回数字时间戳 pong', async () => {
  const { router } = await setup({ now: () => 1234567890 });

  const res = await router.handleMessage(createMessage(PING, {}));

  assert.equal(res.ok, true);
  assert.equal(res.payload.ok, true);
  assert.equal(typeof res.payload.pong, 'number');
  assert.equal(res.payload.pong, 1234567890);
});

test('CLUES_LIST 的 payload 是线索数组本身', async () => {
  const gameKey = 'https://game.example.com::room-1';
  const { router, clueStore } = await setup();

  await clueStore.addClues(gameKey, [{ text: '抽屉里有一张纸', source: 'text' }]);

  const res = await router.handleMessage(createMessage(CLUES_LIST, { gameKey }));

  assert.equal(res.ok, true);
  assert.equal(Array.isArray(res.payload), true);
  assert.ok(res.payload.some((c) => c && c.text === '抽屉里有一张纸'));
});

test('CLUES_EXPORT 含 content 与 filename', async () => {
  const gameKey = 'https://game.example.com::room-1';
  const { router, clueStore } = await setup();

  await clueStore.addClues(gameKey, [{ text: '墙上写着 4312', source: 'text' }]);

  const res = await router.handleMessage(createMessage(CLUES_EXPORT, { gameKey, format: 'json' }));

  assert.equal(res.ok, true);
  assert.equal(typeof res.payload.content, 'string');
  assert.equal(typeof res.payload.filename, 'string');
  assert.equal(res.payload.filename.endsWith('.json'), true);
});

test('ACTIVE_TAB_INFO 返回 origin/isGranted/isCanvas/title 而不是 tab', async () => {
  const { router } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
  });

  const res = await router.handleMessage(createMessage(ACTIVE_TAB_INFO, {}));

  assert.equal(res.ok, true);
  assert.equal(res.payload.origin, 'https://game.example.com');
  assert.equal(res.payload.isGranted, true);
  assert.equal(res.payload.title, '谜题');
  assert.equal('isCanvas' in res.payload, true);
  assert.equal(res.payload.tab, undefined);
});

test('PROVIDER_PERMISSION_REQUEST 把 baseUrl 传给 requestProviderHostPermission', async () => {
  const permCalls = [];
  const fakeSettings = makeRecordingFakeSettings({
    requestProviderHostPermission() {
      permCalls.push(arguments);
      return true;
    },
  });

  const { router } = await setup({ settingsService: fakeSettings });

  const res = await router.handleMessage(
    createMessage(PROVIDER_PERMISSION_REQUEST, {
      provider: 'openai_compatible',
      baseUrl: 'https://api.example.com/v1',
    })
  );

  assert.equal(permCalls.length, 1);
  assert.ok(permCalls[0].length >= 2);
  assert.equal(permCalls[0][1], 'https://api.example.com/v1');

  assert.equal(res.ok, true);
  assert.equal(res.payload.granted, true);
});

test('PANEL_READY 触发 injectReadersIntoOpenTabs，即使注入抛错仍返回正常 ok:true 响应', async () => {
  let injectCalls = 0;
  const { router } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    injectReadersIntoOpenTabs: async () => {
      injectCalls += 1;
      throw new Error('模拟注入失败');
    },
  });

  const res = await router.handleMessage(createMessage(PANEL_READY, {}));
  assert.equal(injectCalls, 1, 'injectReadersIntoOpenTabs 应被调用一次');
  assert.equal(res.ok, true);
  assert.equal(res.payload.origin, 'https://game.example.com');
  assert.equal(Array.isArray(res.payload.clues), true);
});

test('AI_ASK 成功后自动将问答持久化到 clueStore，并脱敏 apiKey', async () => {
  const fakeSettings = makeRecordingFakeSettings({
    getSettings: async () => ({ apiKey: TEST_API_KEY, model: 'gpt-4o' }),
  });
  const gameKey = 'https://game.example.com::room-1';
  const { router, clueStore } = await setup({
    settingsService: fakeSettings,
    answerResult: {
      summary: `含有密钥 ${TEST_API_KEY}`,
      suggestions: [`带密钥 ${TEST_API_KEY}`],
      answer: `密码是 4312 (${TEST_API_KEY})`,
      model: 'gpt-4o',
    },
  });

  const res = await router.handleMessage(
    createMessage(AI_ASK, { gameKey, question: `提问含 ${TEST_API_KEY}` })
  );
  assert.equal(res.ok, true);

  const exported = await clueStore.exportJSON(gameKey);
  assert.equal(exported.includes(TEST_API_KEY), false, '导出严禁包含明文 apiKey');
  assert.ok(exported.includes('***'));

  const parsed = JSON.parse(exported);
  assert.equal(parsed.games[0].qa.length, 1);
  assert.ok(parsed.games[0].qa[0].question.includes('***'));
  assert.ok(parsed.games[0].qa[0].answer.includes('***'));
});

test('READER_DELTA 未传 gameKey 时通过 resolveGameId 写入站点对应复合主键', async () => {
  const storage = createMemoryStorageAdapter();
  const origin = 'https://site-with-id.com';
  const gameId = 'sub-game-9';
  const compositeKey = `${origin}::${gameId}`;

  const fakeSettings = makeRecordingFakeSettings({
    getSettings: async () => ({
      apiKey: TEST_API_KEY,
      gameSites: [{ origin, gameId, enabled: true, granted: true }],
    }),
  });

  const { router, clueStore } = await setup({
    storage,
    settingsService: fakeSettings,
    containsOrigin: async () => true,
    extractResult: {
      clues: [{ text: '找到钥匙卡', source: 'text' }],
      model: 'gpt-4o',
    },
  });

  await router.handleMessage(
    createMessage(READER_DELTA, {
      origin,
      text: '抽屉里有钥匙卡',
    })
  );

  const cluesAtComposite = await clueStore.listClues(compositeKey);
  assert.equal(cluesAtComposite.length, 1);
  assert.equal(cluesAtComposite[0].text, '找到钥匙卡');

  const cluesAtBare = await clueStore.listClues(origin);
  assert.equal(cluesAtBare.length, 0);
});
