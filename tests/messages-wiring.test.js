// 职责：验证网页游戏解谜扩展消息路由器各消息类型的接线行为，包括参数传递、响应形状与广播语义。
// 作者：Banana

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageRouter, classifyVisionError } from '../background/message-router.js';
import {
  createMessage,
  PING,
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
  PANEL_READY,
  READER_SCREENSHOT_REQUEST,
  READER_SCREENSHOT_RESULT,
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
  const queryIsCanvas = overrides.queryIsCanvas;
  const captureCanvas = overrides.captureCanvas;
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
    queryIsCanvas,
    captureCanvas,
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
  assert.equal(res.payload.isCanvas, false);
  assert.equal(res.payload.tab, undefined);
});

test('ACTIVE_TAB_INFO 当 queryIsCanvas 返回 true 时 isCanvas 为 true，返回 false 时为 false', async () => {
  const { router: routerTrue } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    queryIsCanvas: async () => true,
  });
  const resTrue = await routerTrue.handleMessage(createMessage(ACTIVE_TAB_INFO, {}));
  assert.equal(resTrue.ok, true);
  assert.equal(resTrue.payload.isCanvas, true);

  const { router: routerFalse } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    queryIsCanvas: async () => false,
  });
  const resFalse = await routerFalse.handleMessage(createMessage(ACTIVE_TAB_INFO, {}));
  assert.equal(resFalse.ok, true);
  assert.equal(resFalse.payload.isCanvas, false);
});

test('READER_SCREENSHOT_REQUEST 在 payload 已带合法 image 时，即使 captureVisibleTab 抛错，也应 ok 且交由 extractClues', async () => {
  let captureCalled = false;
  const { router, extractCalls } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    captureVisibleTab: async () => {
      captureCalled = true;
      throw new Error('captureVisibleTab fail');
    },
  });

  const res = await router.handleMessage(createMessage(READER_SCREENSHOT_REQUEST, {
    origin: 'https://game.example.com',
    image: { mimeType: 'image/jpeg', dataBase64: 'CUSTOM_PAYLOAD_IMAGE' }
  }));

  assert.equal(captureCalled, false);
  assert.equal(res.ok, true);
  assert.equal(res.payload.ok, true);
  assert.equal(extractCalls.length, 1);
  assert.deepEqual(extractCalls[0][1], { mimeType: 'image/jpeg', dataBase64: 'CUSTOM_PAYLOAD_IMAGE' });
});

test('READER_SCREENSHOT_REQUEST 在 payload 无图但 captureCanvas 返回合法 dataUrl 时，不调用 captureVisibleTab', async () => {
  let captureCalled = false;
  const { router, extractCalls } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    captureCanvas: async () => 'data:image/png;base64,FROM_CANVAS_DATA',
    captureVisibleTab: async () => {
      captureCalled = true;
      throw new Error('captureVisibleTab fail');
    },
  });

  const res = await router.handleMessage(createMessage(READER_SCREENSHOT_REQUEST, {
    origin: 'https://game.example.com'
  }));

  assert.equal(captureCalled, false);
  assert.equal(res.ok, true);
  assert.equal(res.payload.ok, true);
  assert.equal(extractCalls.length, 1);
  assert.deepEqual(extractCalls[0][1], { mimeType: 'image/png', dataBase64: 'FROM_CANVAS_DATA' });
});

test('READER_SCREENSHOT_REQUEST 在 payload 无图且 canvas 采集也没有，captureVisibleTab 抛错时返回错误', async () => {
  const { router, broadcasts } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    captureCanvas: async () => null,
    captureVisibleTab: async () => {
      throw new Error('captureVisibleTab failed');
    },
  });

  const res = await router.handleMessage(createMessage(READER_SCREENSHOT_REQUEST, {
    origin: 'https://game.example.com'
  }));

  assert.equal(res.ok, true);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /网页截图失败/);
  const resultBroadcast = broadcasts.find(b => b.type === 'READER_SCREENSHOT_RESULT');
  assert.ok(resultBroadcast);
  assert.equal(resultBroadcast.payload.ok, false);
  assert.match(resultBroadcast.payload.error, /网页截图失败/);
});

test('classifyVisionError 正确分类各类识图错误并脱敏 API Key', () => {
  const gateErr = new Error('当前选用的 AI 模型不支持图像识别，请在设置中更换为支持视觉的模型（如 gpt-4o 或 gemini-1.5-flash）');
  assert.match(classifyVisionError(gateErr), /^识图门禁:/);

  const httpErr = new Error('OpenAI 接口调用失败 (HTTP 502)');
  const classifiedHttp = classifyVisionError(httpErr);
  assert.match(classifiedHttp, /^识图接口失败:/);
  assert.match(classifiedHttp, /502/);
  assert.doesNotMatch(classifiedHttp, /^识图门禁:/);

  const netErr = new Error('网络请求异常，请检查网络连接');
  assert.match(classifyVisionError(netErr), /^识图网络异常:/);

  const otherErr = new Error('some other reason');
  assert.match(classifyVisionError(otherErr), /some other reason/);

  const secretKey = 'sk-TESTONLY_not_a_real_key_xxxx9999';
  const leakErr = new Error(`调用失败: key=${secretKey}`);
  const sanitized = classifyVisionError(leakErr, secretKey);
  assert.ok(sanitized.includes('***'));
  assert.ok(!sanitized.includes(secretKey));
});

test('READER_SCREENSHOT_REQUEST extractClues 抛出门禁错误时返回分类错误', async () => {
  const { router } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    aiClient: {
      extractClues: async () => {
        throw new Error('当前选用的 AI 模型不支持图像识别，请在设置中更换为支持视觉的模型（如 gpt-4o 或 gemini-1.5-flash）');
      }
    }
  });

  const res = await router.handleMessage(createMessage(READER_SCREENSHOT_REQUEST, {
    origin: 'https://game.example.com',
    image: { mimeType: 'image/jpeg', dataBase64: 'CUSTOM_PAYLOAD_IMAGE' }
  }));

  assert.equal(res.ok, true);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /^识图门禁:/);
});

test('READER_SCREENSHOT_REQUEST extractClues 抛出 HTTP 502 时返回分类错误', async () => {
  const { router } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    aiClient: {
      extractClues: async () => {
        throw new Error('OpenAI 接口调用失败 (HTTP 502)');
      }
    }
  });

  const res = await router.handleMessage(createMessage(READER_SCREENSHOT_REQUEST, {
    origin: 'https://game.example.com',
    image: { mimeType: 'image/jpeg', dataBase64: 'CUSTOM_PAYLOAD_IMAGE' }
  }));

  assert.equal(res.ok, true);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /^识图接口失败:/);
  assert.match(res.payload.error, /502/);
});

test('READER_SCREENSHOT_REQUEST extractClues 抛出网络请求异常时返回分类错误', async () => {
  const { router } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    aiClient: {
      extractClues: async () => {
        throw new Error('网络请求异常，请检查网络连接');
      }
    }
  });

  const res = await router.handleMessage(createMessage(READER_SCREENSHOT_REQUEST, {
    origin: 'https://game.example.com',
    image: { mimeType: 'image/jpeg', dataBase64: 'CUSTOM_PAYLOAD_IMAGE' }
  }));

  assert.equal(res.ok, true);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /^识图网络异常:/);
});

test('READER_SCREENSHOT_REQUEST extractClues 抛出其他错误时返回包含原因的错误', async () => {
  const { router } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    aiClient: {
      extractClues: async () => {
        throw new Error('some other reason');
      }
    }
  });

  const res = await router.handleMessage(createMessage(READER_SCREENSHOT_REQUEST, {
    origin: 'https://game.example.com',
    image: { mimeType: 'image/jpeg', dataBase64: 'CUSTOM_PAYLOAD_IMAGE' }
  }));

  assert.equal(res.ok, true);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /some other reason/);
});

test('READER_SCREENSHOT_REQUEST 第一次成功入库并带有模型标签，第二次失败复现分类错误', async () => {
  let nowMs = 1_700_000_000_000;
  let callCount = 0;
  const clueStore = createClueStore({ storage: createMemoryStorageAdapter() });

  const { router } = await setup({
    now: () => nowMs,
    clueStore,
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    aiClient: {
      extractClues: async () => {
        callCount++;
        if (callCount === 1) {
          return { clues: [{ text: '格子 1-2-3-4', source: 'screenshot' }], model: 'gemini-3.8-flash' };
        }
        throw new Error('OpenAI 接口调用失败 (HTTP 502)');
      }
    }
  });

  const res1 = await router.handleMessage(createMessage(READER_SCREENSHOT_REQUEST, {
    origin: 'https://game.example.com',
    image: { mimeType: 'image/jpeg', dataBase64: 'CUSTOM_PAYLOAD_IMAGE_1' }
  }));

  assert.equal(res1.ok, true);
  assert.equal(res1.payload.ok, true);

  const games = await clueStore.listGames();
  assert.ok(games.length > 0);
  const clues = await clueStore.listClues(games[0].gameKey);
  assert.ok(clues.length > 0);
  assert.equal(clues[0].model, 'gemini-3.8-flash');

  nowMs += 31_000;

  const res2 = await router.handleMessage(createMessage(READER_SCREENSHOT_REQUEST, {
    origin: 'https://game.example.com',
    image: { mimeType: 'image/jpeg', dataBase64: 'CUSTOM_PAYLOAD_IMAGE_2' }
  }));

  assert.equal(res2.ok, true);
  assert.equal(res2.payload.ok, false);
  assert.match(res2.payload.error, /^识图接口失败:/);
});

test('service-worker 源码将 queryIsCanvas 与 captureCanvas 传给了 createMessageRouter', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const swCode = await fs.readFile(path.resolve('./background/service-worker.js'), 'utf8');
  assert.ok(swCode.includes('queryIsCanvas,') || swCode.includes('queryIsCanvas:'));
  assert.ok(swCode.includes('captureCanvas,') || swCode.includes('captureCanvas:'));
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

test('PANEL_READY 触发 injectReadersIntoOpenTabs 且 mock 抛错不影响响应', async () => {
  let injectCalls = 0;
  const { router } = await setup({
    getActiveTab: async () => ({ id: 1, url: 'https://game.example.com/play', title: '谜题', windowId: 1 }),
    containsOrigin: async () => true,
    injectReadersIntoOpenTabs: async () => {
      injectCalls += 1;
      throw new Error('注入模拟失败');
    },
  });

  const res = await router.handleMessage(createMessage(PANEL_READY, {}));

  assert.ok(injectCalls >= 1, 'PANEL_READY 应调用 injectReadersIntoOpenTabs');
  assert.equal(res.ok, true);
  assert.equal(res.payload.origin, 'https://game.example.com');
  assert.equal(Array.isArray(res.payload.clues), true);
});

test('AI_ASK 成功后将脱敏问答存入 clueStore 并可在导出中看到，存储异常不破坏回答', async () => {
  const fakeSettings = makeRecordingFakeSettings({
    getSettings: async () => ({ apiKey: TEST_API_KEY, model: 'gpt-4o', provider: 'openai_compatible' }),
  });

  const gameKey = 'https://game.example.com::room-ask-test';
  let fixedTime = 2000;
  const storage = createMemoryStorageAdapter();
  const clueStore = createClueStore({
    storage,
    now: () => fixedTime,
  });

  const { router } = await setup({
    settingsService: fakeSettings,
    clueStore,
    answerResult: {
      summary: `包含假密钥 ${TEST_API_KEY} 的总结`,
      suggestions: [`建议不要泄露 ${TEST_API_KEY}`],
      answer: `密码是 9999 且附带 ${TEST_API_KEY}`,
      model: 'gpt-4o',
    },
  });

  const res = await router.handleMessage(
    createMessage(AI_ASK, {
      gameKey,
      question: `关于 ${TEST_API_KEY} 的问题`,
    })
  );

  assert.equal(res.ok, true);

  const exported = await clueStore.exportJSON(gameKey);
  assert.equal(exported.includes(TEST_API_KEY), false, '导出中绝对不应包含真实 API Key 明文');
  assert.ok(exported.includes('***'), 'API Key 应被替换为 ***');
  const parsed = JSON.parse(exported);
  assert.equal(parsed.games[0].qa.length, 1);
  assert.ok(parsed.games[0].qa[0].question.includes('***'));
  assert.ok(parsed.games[0].qa[0].answer.includes('***'));

  // 验证 addQa 抛错时仍返回正常回答
  clueStore.addQa = async () => {
    throw new Error('存储崩溃');
  };
  const res2 = await router.handleMessage(
    createMessage(AI_ASK, { gameKey, question: '第二问' })
  );
  assert.equal(res2.ok, true);
  assert.ok(res2.payload.answer);
});

test('READER_DELTA 在缺少 payload.gameKey 时结合站点配置的 gameId 生成复合键写入线索', async () => {
  const origin = 'https://multi.game.site';
  const gameId = 'puzzle-chamber-3';
  const expectedKey = `${origin}::${gameId}`;

  const fakeSettings = makeRecordingFakeSettings({
    getSettings: async () => ({
      apiKey: TEST_API_KEY,
      gameSites: [{ origin, gameId, granted: true, enabled: true }],
    }),
  });

  const storage = createMemoryStorageAdapter();
  const clueStore = createClueStore({ storage });

  const { router } = await setup({
    settingsService: fakeSettings,
    clueStore,
    containsOrigin: async () => true,
    extractResult: {
      clues: [{ text: '隐藏的壁画符号', source: 'text', tags: ['线索'] }],
      model: 'gpt-4o',
    },
  });

  await router.handleMessage(
    createMessage(READER_DELTA, {
      origin,
      gameKey: '', // 故意留空
      text: '发现壁画上有奇怪的符号',
    })
  );

  const compoundClues = await clueStore.listClues(expectedKey);
  assert.equal(compoundClues.length, 1);
  assert.equal(compoundClues[0].text, '隐藏的壁画符号');

  const bareClues = await clueStore.listClues(origin);
  assert.equal(bareClues.length, 0);
});
