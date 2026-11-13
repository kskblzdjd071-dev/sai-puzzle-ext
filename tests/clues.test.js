// 职责：线索存储、去重、排序及脱敏导出单元测试
// 作者：Peter

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeGameKey,
  parseGameKey,
  dedupeKey,
  createClueStore,
  sanitizeSecretText
} from '../core/clues.js';
import { createMemoryStorageAdapter } from '../adapters/storage.js';

test('makeGameKey / parseGameKey 双向往返测试（含 gameId 与不含 gameId）', () => {
  const withIdKey = makeGameKey('https://example.com', 'room-42');
  assert.equal(withIdKey, 'https://example.com::room-42');
  const parsedWithId = parseGameKey(withIdKey);
  assert.equal(parsedWithId.origin, 'https://example.com');
  assert.equal(parsedWithId.gameId, 'room-42');

  const withoutIdKey = makeGameKey('https://example.com');
  assert.equal(withoutIdKey, 'https://example.com');
  const parsedWithoutId = parseGameKey(withoutIdKey);
  assert.equal(parsedWithoutId.origin, 'https://example.com');
  assert.equal(parsedWithoutId.gameId, undefined);

  const emptyIdKey = makeGameKey('https://example.com', '   ');
  assert.equal(emptyIdKey, 'https://example.com');
  const parsedEmptyId = parseGameKey(emptyIdKey);
  assert.equal(parsedEmptyId.origin, 'https://example.com');
  assert.equal(parsedEmptyId.gameId, undefined);
});

test('dedupeKey 规范化文本处理', () => {
  assert.equal(dedupeKey({ text: '  Hello   WORLD \n ' }), 'hello world');
  assert.equal(dedupeKey({ text: '密室   钥匙  A ' }), '密室 钥匙 a');
  assert.equal(dedupeKey(null), '');
  assert.equal(dedupeKey({}), '');
});

test('连续或一次性添加多条大小写/空白不同的同义线索，只入库 1 条', async () => {
  const storage = createMemoryStorageAdapter();
  const store = createClueStore({ storage });
  const gameKey = 'https://escape.game::room-1';

  const batch = [
    { text: '  Silver   Key  ' },
    { text: 'silver key' },
    { text: '   SILVER   KEY \t' }
  ];

  const added = await store.addClues(gameKey, batch);
  assert.equal(added.length, 1);
  assert.equal(added[0].text, 'Silver   Key');

  const clues = await store.listClues(gameKey);
  assert.equal(clues.length, 1);
  assert.equal(clues[0].text, 'Silver   Key');

  const addedAgain = await store.addClues(gameKey, [{ text: 'silver   key' }]);
  assert.equal(addedAgain.length, 0);

  const cluesAfter = await store.listClues(gameKey);
  assert.equal(cluesAfter.length, 1);
});

test('listClues 严格按 createdAt 升序返回，并支持可控 now 与 id', async () => {
  const storage = createMemoryStorageAdapter();
  let timeCursor = 1000;
  let idCursor = 1;
  const store = createClueStore({
    storage,
    now: () => timeCursor,
    id: () => `id_${idCursor++}`
  });
  const gameKey = 'https://game.test';

  timeCursor = 2000;
  await store.addClues(gameKey, [{ text: '第二条线索' }]);

  timeCursor = 1000;
  await store.addClues(gameKey, [{ text: '第一条线索' }]);

  timeCursor = 3000;
  await store.addClues(gameKey, [{ text: '第三条线索' }]);

  const list = await store.listClues(gameKey);
  assert.equal(list.length, 3);
  assert.equal(list[0].text, '第一条线索');
  assert.equal(list[0].createdAt, 1000);
  assert.equal(list[1].text, '第二条线索');
  assert.equal(list[1].createdAt, 2000);
  assert.equal(list[2].text, '第三条线索');
  assert.equal(list[2].createdAt, 3000);
});

test('exportJSON 与 exportMarkdown 绝对不含 apiKey 与 baseUrl 字样，且阻断敏感键', async () => {
  const storage = createMemoryStorageAdapter();
  const store = createClueStore({ storage });
  const gameKey = 'https://clean.game::room-9';

  await store.addClues(gameKey, [
    { text: '普通提示文本', tags: ['安全'] }
  ]);

  const json = await store.exportJSON(gameKey);
  assert.equal(/apiKey|baseUrl/i.test(json), false);

  const md = await store.exportMarkdown(gameKey);
  assert.equal(/apiKey|baseUrl/i.test(md), false);

  // 模拟非法注入敏感属性阻断
  await storage.set('clues:v1:dirty', {
    gameKey: 'dirty',
    apiKey: 'sk-should-not-exist',
    clues: []
  });

  await assert.rejects(
    async () => {
      await store.exportJSON();
    },
    /严重安全违规/
  );
});

test('边界情况与异常校验：空参数、空数组、空库导出及 Markdown 倒序结构', async () => {
  const storage = createMemoryStorageAdapter();
  const store = createClueStore({ storage });

  await assert.rejects(async () => {
    await store.addClues('', [{ text: 'test' }]);
  }, /gameKey 不能为空/);

  await assert.rejects(async () => {
    await store.listClues('');
  }, /gameKey 不能为空/);

  // 空数组 addClues 不抛错且不向 storage 写入数据
  const emptyRes = await store.addClues('https://noop.com', []);
  assert.deepEqual(emptyRes, []);
  const keysBefore = await storage.listKeys();
  assert.equal(keysBefore.length, 0);

  // 未写过记录时 listClues 返回空数组且不写入 storage
  const emptyList = await store.listClues('https://noop.com');
  assert.deepEqual(emptyList, []);
  const keysAfterList = await storage.listKeys();
  assert.equal(keysAfterList.length, 0);

  // export 空库不抛错
  const emptyJson = await store.exportJSON();
  const parsedJson = JSON.parse(emptyJson);
  assert.equal(parsedJson.games.length, 0);

  const emptyMd = await store.exportMarkdown();
  assert.ok(emptyMd.startsWith('# 游戏线索归档'));
  assert.ok(emptyMd.includes('*暂无任何线索记录*'));

  // 不同文本共存，并验证 Markdown 导出格式与时间倒序
  let t = 100;
  const timeStore = createClueStore({
    storage,
    now: () => t++
  });
  const gameKey = 'https://demo.site::room-2';
  await timeStore.addClues(gameKey, [
    { text: '线索A（较早）', tags: ['初始'] },
    { text: '线索B（较晚）', tags: ['关键'] }
  ]);

  const mdWithData = await timeStore.exportMarkdown(gameKey);
  assert.ok(mdWithData.includes('# 游戏线索归档'));
  const posA = mdWithData.indexOf('线索A（较早）');
  const posB = mdWithData.indexOf('线索B（较晚）');
  assert.ok(posB < posA, 'Markdown 中的线索应按时间倒序排列');

  // 空线索游戏归档文案
  await storage.set('clues:v1:empty-game', {
    gameKey: 'empty-game',
    origin: 'empty-game',
    title: '空线索游戏',
    clues: [],
    createdAt: 10,
    updatedAt: 10
  });
  const mdEmptyGame = await timeStore.exportMarkdown('empty-game');
  assert.ok(mdEmptyGame.includes('*此游戏暂无线索*'));

  // 删除与清空操作
  const clues = await timeStore.listClues(gameKey);
  assert.equal(clues.length, 2);
  const removed = await timeStore.removeClue(gameKey, clues[0].id);
  assert.equal(removed, true);
  const remaining = await timeStore.listClues(gameKey);
  assert.equal(remaining.length, 1);

  await timeStore.clearGame(gameKey);
  const cleared = await timeStore.getGame(gameKey);
  assert.equal(cleared, null);
});

test('addQa 按 gameKey 持久化，listQa 与 getGame().qa 能读回', async () => {
  const storage = createMemoryStorageAdapter();
  const store = createClueStore({
    storage,
    now: () => 5000,
    id: () => 'qa_test_1'
  });
  const gameKey = 'https://game.test::room-qa';

  const entry = await store.addQa(gameKey, {
    question: '红色箱子的密码？',
    answer: '查看墙壁涂鸦，为 7293',
    summary: '墙壁涂鸦包含数字',
    suggestions: ['去红箱子处输入'],
    model: 'gpt-4o'
  });

  assert.ok(entry);
  assert.equal(entry.question, '红色箱子的密码？');
  assert.equal(entry.answer, '查看墙壁涂鸦，为 7293');
  assert.equal(entry.createdAt, 5000);
  assert.equal(entry.model, 'gpt-4o');

  const list = await store.listQa(gameKey);
  assert.equal(list.length, 1);
  assert.equal(list[0].question, '红色箱子的密码？');
  assert.equal(list[0].answer, '查看墙壁涂鸦，为 7293');

  const game = await store.getGame(gameKey);
  assert.ok(game);
  assert.equal(Array.isArray(game.qa), true);
  assert.equal(game.qa.length, 1);
  assert.equal(game.qa[0].question, '红色箱子的密码？');

  // 空 question 或空 answer 不写入
  const skipped1 = await store.addQa(gameKey, { question: '', answer: '有答案' });
  assert.equal(skipped1, null);
  const skipped2 = await store.addQa(gameKey, { question: '有提问', answer: '  ' });
  assert.equal(skipped2, null);
  const listAfterSkip = await store.listQa(gameKey);
  assert.equal(listAfterSkip.length, 1);
});

test('exportJSON 包含 qa 数组，exportMarkdown 包含问答区块', async () => {
  const storage = createMemoryStorageAdapter();
  const store = createClueStore({
    storage,
    now: () => 8888
  });
  const gameKey = 'https://game.test::room-export';

  await store.addClues(gameKey, [{ text: '找到一把小刀' }]);
  await store.addQa(gameKey, {
    question: '小刀有什么用？',
    answer: '割开沙发上的缝线获取钥匙'
  });

  const jsonStr = await store.exportJSON(gameKey);
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.games.length, 1);
  assert.equal(Array.isArray(parsed.games[0].qa), true);
  assert.equal(parsed.games[0].qa.length, 1);
  assert.equal(parsed.games[0].qa[0].question, '小刀有什么用？');
  assert.equal(parsed.games[0].qa[0].answer, '割开沙发上的缝线获取钥匙');

  const md = await store.exportMarkdown(gameKey);
  assert.ok(md.includes('### 问答记录'));
  assert.ok(md.includes('**问**：小刀有什么用？'));
  assert.ok(md.includes('**答**：割开沙发上的缝线获取钥匙'));
});

test('无线索但有问答时，JSON 仍导出该 game 且 qa 非空、clues 为空', async () => {
  const storage = createMemoryStorageAdapter();
  const store = createClueStore({ storage });
  const gameKey = 'https://game.test::room-qa-only';

  await store.addQa(gameKey, {
    question: '现在该怎么走？',
    answer: '向左转'
  });

  const jsonStr = await store.exportJSON(gameKey);
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.games.length, 1);
  assert.equal(parsed.games[0].clues.length, 0);
  assert.equal(parsed.games[0].qa.length, 1);
  assert.equal(parsed.games[0].qa[0].question, '现在该怎么走？');
});

test('addClues 与导出自动脱敏配置密钥和 sk- 形态密钥为 ***', async () => {
  const configuredKey = 'sk-TESTONLY_configured_key_abcdefg';
  const embeddedKey = 'sk-TESTONLY_embedded_other_key_xyz999';

  const storage = createMemoryStorageAdapter();
  const store = createClueStore({
    storage,
    getApiKey: () => configuredKey
  });
  const gameKey = 'https://game.test::room-sanitize';

  const added = await store.addClues(gameKey, [
    {
      text: `发现日志：用户使用了密钥 ${configuredKey}，还有临时凭据 ${embeddedKey}。`,
      tags: [`tag-${embeddedKey}`]
    }
  ]);

  assert.equal(added.length, 1);
  assert.equal(added[0].text.includes(configuredKey), false);
  assert.equal(added[0].text.includes(embeddedKey), false);
  assert.ok(added[0].text.includes('***'));
  assert.equal(added[0].tags[0].includes(embeddedKey), false);
  assert.ok(added[0].tags[0].includes('***'));

  const clues = await store.listClues(gameKey);
  assert.equal(clues[0].text.includes(configuredKey), false);
  assert.equal(clues[0].text.includes(embeddedKey), false);
  assert.ok(clues[0].text.includes('***'));

  const jsonStr = await store.exportJSON(gameKey);
  assert.equal(jsonStr.includes(configuredKey), false);
  assert.equal(jsonStr.includes(embeddedKey), false);
  assert.ok(jsonStr.includes('***'));

  const mdStr = await store.exportMarkdown(gameKey);
  assert.equal(mdStr.includes(configuredKey), false);
  assert.equal(mdStr.includes(embeddedKey), false);
  assert.ok(mdStr.includes('***'));

  // 验证即使历史数据中已有明文（例如直接写入 storage），导出时也能二次脱敏
  await storage.set('clues:v1:legacy-leak', {
    gameKey: 'legacy-leak',
    origin: 'legacy-leak',
    title: '历史泄漏测试',
    clues: [
      {
        id: 'legacy-1',
        gameKey: 'legacy-leak',
        text: `历史明文密钥：${configuredKey} 和 ${embeddedKey}`,
        createdAt: 1000
      }
    ],
    qa: [],
    createdAt: 1000,
    updatedAt: 1000
  });

  const legacyJson = await store.exportJSON('legacy-leak');
  assert.equal(legacyJson.includes(configuredKey), false);
  assert.equal(legacyJson.includes(embeddedKey), false);
  assert.ok(legacyJson.includes('***'));

  const legacyMd = await store.exportMarkdown('legacy-leak');
  assert.equal(legacyMd.includes(configuredKey), false);
  assert.equal(legacyMd.includes(embeddedKey), false);
  assert.ok(legacyMd.includes('***'));
});

test('sanitizeSecretText 保护普通中划线业务词原样保留', () => {
  assert.equal(sanitizeSecretText('task-management01'), 'task-management01');
  assert.equal(sanitizeSecretText('risk-assessment'), 'risk-assessment');
  assert.equal(sanitizeSecretText('desk-lamp-model-2000'), 'desk-lamp-model-2000');
});

test('createClueStore 配置短密钥时不把短串替换为 *** 保留正文', async () => {
  const storage = createMemoryStorageAdapter();
  const store = createClueStore({
    storage,
    getApiKey: () => 'shortkey'
  });
  const gameKey = 'https://game.test::shortkey-preserve';

  const added = await store.addClues(gameKey, [
    {
      text: 'shortkey inside text',
      tags: ['clue']
    }
  ]);

  assert.equal(added.length, 1);
  assert.ok(added[0].text.includes('shortkey'));

  const clues = await store.listClues(gameKey);
  assert.ok(clues[0].text.includes('shortkey'));

  const jsonStr = await store.exportJSON(gameKey);
  assert.ok(jsonStr.includes('shortkey'));

  const mdStr = await store.exportMarkdown(gameKey);
  assert.ok(mdStr.includes('shortkey'));
});
