// 网页游戏解谜整理插件 - 核心协议与适配器冒烟测试
// 覆盖规范约定的 5 大核心模块及纯逻辑边界
import assert from 'node:assert/strict';
import { createMemoryStorageAdapter } from '../adapters/storage.js';
import { createMockHttpAdapter } from '../adapters/http.js';
import { makeGameKey, parseGameKey } from '../core/models.js';
import {
  DEFAULT_SETTINGS,
  normalizeOrigin,
  redactSecret,
  createSettingsService
} from '../core/settings.js';
import { createClueStore } from '../core/clues.js';
import {
  MESSAGE_TYPES,
  PING,
  SETTINGS_GET,
  READER_DELTA,
  AI_ASK,
  SITES_ADD,
  createResponse,
  assertSafeErrorMessage
} from '../core/messages.js';
import {
  assertNoSecretInText,
  buildExtractPrompt,
  buildAnswerPrompt,
  createAiClient
} from '../core/ai.js';

export const tests = [
  // 1. makeGameKey / parseGameKey 往返测试
  {
    name: 'models: makeGameKey 与 parseGameKey 正确往返处理 (带/不带 gameId)',
    fn: async () => {
      const k1 = makeGameKey('https://game.example.com', 'room-101');
      const p1 = parseGameKey(k1);
      assert.equal(p1.origin, 'https://game.example.com');
      assert.equal(p1.gameId, 'room-101');

      const k2 = makeGameKey('https://puzzle.org', '');
      const p2 = parseGameKey(k2);
      assert.equal(p2.origin, 'https://puzzle.org');
      assert.ok(!p2.gameId);
    }
  },

  // 2. normalizeOrigin 测试
  {
    name: 'settings: normalizeOrigin 正确提取带端口、路径及 hash 的 origin，非法输入抛错',
    fn: async () => {
      assert.equal(
        normalizeOrigin('https://sub.domain.com:8080/path/to/game?arg=1#frag'),
        'https://sub.domain.com:8080'
      );
      assert.equal(
        normalizeOrigin('http://localhost:3000/'),
        'http://localhost:3000'
      );
      assert.throws(
        () => normalizeOrigin('://'),
        /网址|URL|origin/i
      );
    }
  },

  // 3. settings 服务及脱敏测试
  {
    name: 'settings: 内存存储与假 permissions 往返保存读取，getRedactedSettings 永不暴露明文',
    fn: async () => {
      const storage = createMemoryStorageAdapter();
      const fakePermissions = {
        async requestOrigin() { return true; },
        async removeOrigin() { return true; },
        async containsOrigin() { return true; },
        async registerReader() {},
        async unregisterReader() {},
        async requestHost() { return true; }
      };

      const service = createSettingsService({ storage, permissions: fakePermissions });
      const initial = await service.getSettings();
      assert.equal(initial.provider, DEFAULT_SETTINGS.provider);

      const fakeKey = 'sk-TESTONLY_not_a_real_key_xxxx9999';
      await service.saveSettings({ apiKey: fakeKey, provider: 'openai_compatible' });

      const fetched = await service.getSettings();
      assert.equal(fetched.apiKey, fakeKey);
      assert.equal(fetched.provider, 'openai_compatible');

      const redacted = await service.getRedactedSettings();
      assert.equal(redacted.hasApiKey, true);
      assert.ok(typeof redacted.apiKeyMasked === 'string');
      assert.ok(!redacted.apiKeyMasked.includes('xxxx9999'));
      assert.equal(redacted.apiKey, undefined);

      assert.equal(redactSecret(''), '');
      assert.equal(redactSecret('abc'), '****');
      assert.ok(redactSecret('sk-TESTONLY_not_a_real_key_xxxx9999').includes('****'));
    }
  },

  // 4. 线索添加、去重、排序及导出防泄漏测试
  {
    name: 'clues: 添加线索大小写与空白去重，升序排列，导出内容杜绝密钥信息',
    fn: async () => {
      const storage = createMemoryStorageAdapter();
      let fakeTime = 1000;
      let fakeId = 1;
      const store = createClueStore({
        storage,
        now: () => fakeTime++,
        id: () => `id_${fakeId++}`
      });

      const key = makeGameKey('https://escape.test', 'game-1');

      // 规则：两条完全一致（仅空格与大小写差异）+ 一条不同 -> 库中应总计 2 条
      const cluesBatch = [
        { text: 'Golden Key', type: 'item' },
        { text: '  golden key  ', type: 'item' },
        { text: 'Silver Key', type: 'item' }
      ];

      const added = await store.addClues(key, cluesBatch);
      assert.equal(added.length, 2, '首轮添加应该去重为 2 条');

      // 再次添加相同内容，新增应为 0
      const addedAgain = await store.addClues(key, [{ text: 'GOLDEN KEY', type: 'item' }]);
      assert.equal(addedAgain.length, 0);

      const list = await store.listClues(key);
      assert.equal(list.length, 2);
      assert.ok(list[0].createdAt <= list[1].createdAt, '线索应按时间升序');

      const jsonStr = await store.exportJSON(key);
      assert.equal(typeof jsonStr, 'string');
      assert.ok(!/apiKey/i.test(jsonStr));

      const mdStr = await store.exportMarkdown(key);
      assert.equal(typeof mdStr, 'string');
      assert.ok(!/apiKey/i.test(mdStr));
    }
  },

  // 5. 消息常量与错误信息防泄漏脱敏
  {
    name: 'messages: MESSAGE_TYPES 完备性，assertSafeErrorMessage 拦截并脱敏明文密钥',
    fn: async () => {
      const requiredTypes = [PING, SETTINGS_GET, READER_DELTA, AI_ASK, SITES_ADD];
      for (const t of requiredTypes) {
        assert.ok(MESSAGE_TYPES.includes(t), `MESSAGE_TYPES 必须包含 ${t}`);
      }

      const fakeKey = 'sk-TESTONLY_not_a_real_key_xxxx9999';
      const rawError = `网络请求失败，涉及密钥: ${fakeKey}`;

      const safeMessage = assertSafeErrorMessage(rawError, fakeKey);
      assert.ok(!safeMessage.includes(fakeKey));
      assert.ok(safeMessage.includes('已隐藏敏感信息'));

      const resp = createResponse(PING, 'req_1', false, null, rawError, fakeKey);
      assert.equal(resp.ok, false);
      assert.ok(resp.error && !resp.error.message.includes(fakeKey));
    }
  },

  // 6. AI 模块：安全文本检测
  {
    name: 'ai: assertNoSecretInText 遇到假密钥抛出异常，安全输入正常通过',
    fn: async () => {
      const fakeKey = 'sk-TESTONLY_not_a_real_key_xxxx9999';
      assert.doesNotThrow(() => {
        assertNoSecretInText('这是一段正常的解谜日记文本', fakeKey);
      });
      assert.throws(() => {
        assertNoSecretInText(`我的密钥是 ${fakeKey}，请保存`, fakeKey);
      });
    }
  },

  // 7. AI 模块：Prompt 结构非空校验
  {
    name: 'ai: buildExtractPrompt 与 buildAnswerPrompt 生成有效 prompt 结构',
    fn: async () => {
      const extractPrompt = buildExtractPrompt('发现一张带血的旧羊皮纸', false);
      assert.ok(extractPrompt.system && extractPrompt.system.length > 0);
      assert.ok(extractPrompt.user && extractPrompt.user.length > 0);

      const answerPrompt = buildAnswerPrompt('羊皮纸上的数字是什么含义？', [
        { text: '羊皮纸标注了 1984' }
      ]);
      assert.ok(answerPrompt.system && answerPrompt.system.length > 0);
      assert.ok(answerPrompt.user && answerPrompt.user.length > 0);
    }
  },

  // 8. AI 客户端：模型提取线索与问答测试
  {
    name: 'ai: mock http 返回 OpenAI 兼容结构，extractClues 解析 JSON 数组且 answerQuestion 返回文本',
    fn: async () => {
      const fakeApiKey = 'test-key-ABCDEFG-PLACEHOLDER';
      const mockClues = [{ text: '铜钥匙', type: 'item' }];

      let reqCount = 0;
      const http = createMockHttpAdapter(async (_url, init) => {
        reqCount++;
        const _body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;

        if (reqCount === 1) {
          const payload = {
            choices: [
              {
                message: {
                  content: JSON.stringify(mockClues)
                }
              }
            ]
          };
          return {
            status: 200,
            text: JSON.stringify(payload),
            json: payload
          };
        }

        const payload = {
          choices: [
            {
              message: {
                content: '铜钥匙可用于开启地下室的铁锁。'
              }
            }
          ]
        };
        return {
          status: 200,
          text: JSON.stringify(payload),
          json: payload
        };
      });

      const client = createAiClient({
        http,
        getSettings: async () => ({
          provider: 'openai_compatible',
          apiKey: fakeApiKey,
          model: 'mock-model',
          baseUrl: 'https://api.openai.test/v1'
        })
      });

      const result = await client.extractClues('在花盆底找到一把生锈的铜钥匙', null);
      assert.equal(Array.isArray(result.clues), true);
      assert.equal(result.clues[0].text, '铜钥匙');

      const answerResult = await client.answerQuestion('这把钥匙有什么用？', result.clues);
      assert.ok(typeof answerResult.answer === 'string');
      assert.ok(answerResult.answer.includes('地下室'));
    }
  },

  // 9. AI 客户端：空文本请求短路优化
  {
    name: 'ai: extractClues 遇到空文本或纯空白且无图像时，绝不发起网络调用',
    fn: async () => {
      let callCount = 0;
      const http = createMockHttpAdapter(async () => {
        callCount++;
        return { status: 200, text: '{}', json: {} };
      });

      const client = createAiClient({
        http,
        getSettings: async () => ({
          provider: 'openai_compatible',
          apiKey: 'test-key-ABCDEFG-PLACEHOLDER'
        })
      });

      const r1 = await client.extractClues('', null);
      const r2 = await client.extractClues('   ', null);

      assert.deepEqual(r1.clues, []);
      assert.deepEqual(r2.clues, []);
      assert.equal(callCount, 0, 'http.request 调用次数必须为 0');
    }
  },

  // 10. content/reader 纯函数差量计算测试
  {
    name: 'reader: computeDelta 正确提取增量后缀或新增文本行',
    fn: async () => {
      const { computeDelta } = await import('../content/reader.js');
      const base = '第一章 开始\n房间很暗。';
      const next1 = '第一章 开始\n房间很暗。\n地上有一枚硬币。';
      const delta1 = computeDelta(base, next1);
      assert.equal(delta1, '地上有一枚硬币。');

      const next2 = '重载章节\n地上一枚硬币\n房间很暗。';
      const delta2 = computeDelta(base, next2);
      assert.ok(delta2.includes('重载章节'));
    }
  }
];
