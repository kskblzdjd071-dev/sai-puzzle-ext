import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertNoSecretInText,
  buildExtractPrompt,
  buildAnswerPrompt,
  selectProvider,
  createAiClient
} from '../core/ai.js';
import { openaiAdapter } from '../core/providers/openai.js';
import { deepseekAdapter } from '../core/providers/deepseek.js';
import { geminiAdapter } from '../core/providers/gemini.js';
import { createMockHttpAdapter } from '../adapters/http.js';

const MOCK_API_KEY = 'sk-test-key-abcdef123456';

function createMockSettings(overrides = {}) {
  return {
    provider: 'openai_compatible',
    apiKey: MOCK_API_KEY,
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    gameSites: [],
    batchIntervalMs: 5000,
    screenshotMaxIntervalMs: 30000,
    ...overrides
  };
}

test('assertNoSecretInText: 密钥泄漏检测规则', () => {
  const secret = 'sk-test-secret-value-12345';

  assert.throws(
    () => {
      assertNoSecretInText(`请求异常: apiKey=${secret}`, secret);
    },
    {
      name: 'Error',
      message: '严重安全违规：文本中侦测到 API Key 泄漏风险'
    }
  );

  assert.doesNotThrow(() => {
    assertNoSecretInText('这是一段正常的安全文本，没有密钥', secret);
  });

  assert.doesNotThrow(() => {
    assertNoSecretInText('包含短串 abcde 的文本', 'abcde');
  });

  assert.doesNotThrow(() => {
    assertNoSecretInText(null, secret);
    assertNoSecretInText('', secret);
    assertNoSecretInText('文本', '');
    assertNoSecretInText('文本', null);
  });
});

test('buildExtractPrompt 与 buildAnswerPrompt 规范固定文本', () => {
  const extract = buildExtractPrompt('增量文本', false);
  assert.equal(
    extract.system,
    '你是一位专业的解谜游戏助手。请从用户提供的网页游戏最新文本增量或画面中，提炼出具有解谜价值的关键线索、密码、物品、位置信息。必须以 JSON 数组格式输出，字段格式：[{"text":"线索简述","tags":["标签"]}]。若无新线索，返回空数组 []。不要输出任何 Markdown 代码围栏之外的多余解释。'
  );

  const answer = buildAnswerPrompt('怎么开门？', []);
  assert.equal(
    answer.system,
    '你是一位解谜智囊。以下是当前游戏已记录的所有已知线索。请根据这些客观事实回答玩家当前的疑问，并给出后续探索建议。输出必须包含三部分：1. 现状线索总结；2. 建议的下一步；3. 针对问题的具体解答。'
  );
});

test('supportsVision 精确匹配正例与反例', () => {
  // OpenAI
  assert.equal(openaiAdapter.supportsVision('gpt-4o'), true);
  assert.equal(openaiAdapter.supportsVision('GPT-4O'), true);
  assert.equal(openaiAdapter.supportsVision('gpt-4o-mini'), true);
  assert.equal(openaiAdapter.supportsVision('gpt-4o-2024-08-06'), true);
  assert.equal(openaiAdapter.supportsVision('gpt-4o-mini-2024-07-18'), true);
  assert.equal(openaiAdapter.supportsVision('gpt-4-turbo'), true);
  assert.equal(openaiAdapter.supportsVision('gpt-4-turbo-2024-04-09'), true);
  assert.equal(openaiAdapter.supportsVision('gpt-4o-001'), true);

  assert.equal(openaiAdapter.supportsVision('gpt-4'), false);
  assert.equal(openaiAdapter.supportsVision('gpt-3.5-turbo'), false);
  assert.equal(openaiAdapter.supportsVision('gpt-4-vision'), false);
  assert.equal(openaiAdapter.supportsVision('gpt-4-vision-preview'), false);
  assert.equal(openaiAdapter.supportsVision('gpt-4o-realtime'), false);
  assert.equal(openaiAdapter.supportsVision('my-vision-model'), false);
  assert.equal(openaiAdapter.supportsVision(''), false);
  assert.equal(openaiAdapter.supportsVision(null), false);

  // DeepSeek 一律为 false
  assert.equal(deepseekAdapter.supportsVision('deepseek-chat'), false);
  assert.equal(deepseekAdapter.supportsVision('deepseek-vl'), false);

  // Gemini
  assert.equal(geminiAdapter.supportsVision('gemini-1.5-pro'), true);
  assert.equal(geminiAdapter.supportsVision('gemini-1.5-flash'), true);
  assert.equal(geminiAdapter.supportsVision('gemini-2.0-flash'), true);
  assert.equal(geminiAdapter.supportsVision('gemini-1.5-flash-001'), true);
  assert.equal(geminiAdapter.supportsVision('models/gemini-1.5-pro'), true);

  assert.equal(geminiAdapter.supportsVision('gemini-pro-vision'), false);
  assert.equal(geminiAdapter.supportsVision('gemini-1.5-flash-8b'), false);
  assert.equal(geminiAdapter.supportsVision('gemini-2.0-flash-lite'), false);
  assert.equal(geminiAdapter.supportsVision('gemini-2.0-pro'), false);
  assert.equal(geminiAdapter.supportsVision('gemini-1.0-pro'), false);
  assert.equal(geminiAdapter.supportsVision('gemini-1.5-ultra'), false);
  assert.equal(geminiAdapter.supportsVision(''), false);
  assert.equal(geminiAdapter.supportsVision(null), false);
});

test('extractClues: 空文本且无图像时直接返回空，且不发起 HTTP 请求', async () => {
  let callCount = 0;
  const http = createMockHttpAdapter(async () => {
    callCount += 1;
    return { status: 200, text: '{}', json: {} };
  });

  const client = createAiClient({
    http,
    getSettings: async () => createMockSettings()
  });

  const res1 = await client.extractClues('', null);
  assert.deepEqual(res1, { clues: [], model: 'none' });

  const res2 = await client.extractClues({ delta: '   ', image: null });
  assert.deepEqual(res2, { clues: [], model: 'none' });

  assert.equal(callCount, 0);
});

test('视觉拒绝：非视觉模型带图像时抛出精确中文错误，且不发起 HTTP 请求', async () => {
  let callCount = 0;
  const http = createMockHttpAdapter(async () => {
    callCount += 1;
    return { status: 200, text: '{}', json: {} };
  });

  // 测试 OpenAI gpt-3.5-turbo
  const openAiClient = createAiClient({
    http,
    getSettings: async () =>
      createMockSettings({
        provider: 'openai_compatible',
        model: 'gpt-3.5-turbo'
      })
  });

  await assert.rejects(
    async () => {
      await openAiClient.extractClues({
        delta: '房间内有一张桌子',
        image: { mimeType: 'image/jpeg', dataBase64: 'ZmFrZQ==' }
      });
    },
    {
      name: 'Error',
      message:
        '当前选用的 AI 模型不支持图像识别，请在设置中更换为支持视觉的模型（如 gpt-4o 或 gemini-1.5-flash）'
    }
  );

  // 测试 DeepSeek
  const deepseekClient = createAiClient({
    http,
    getSettings: async () =>
      createMockSettings({
        provider: 'deepseek',
        model: 'deepseek-chat'
      })
  });

  await assert.rejects(
    async () => {
      await deepseekClient.extractClues({
        delta: '房间内有一张桌子',
        image: { mimeType: 'image/jpeg', dataBase64: 'ZmFrZQ==' }
      });
    },
    {
      name: 'Error',
      message:
        '当前选用的 AI 模型不支持图像识别，请在设置中更换为支持视觉的模型（如 gpt-4o 或 gemini-1.5-flash）'
    }
  );

  assert.equal(callCount, 0);
});

test('OpenAI 适配器：extractClues 与 answerQuestion 完整闭环、解包与 camelCase usage 归一化', async () => {
  const requests = [];
  const http = createMockHttpAdapter(async (url, init) => {
    requests.push({ url, init });

    if (requests.length === 1) {
      // extractClues 响应
      const responseData = {
        model: 'gpt-4o',
        choices: [
          {
            message: {
              content:
                '```json\n[{"text":"墙上写着密码 8421","tags":["密码","重要"]}]\n```'
            }
          }
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150
        }
      };
      return {
        status: 200,
        text: JSON.stringify(responseData),
        json: responseData
      };
    }

    // answerQuestion 响应
    const answerContent =
      '【现状线索总结】\n玩家当前掌握了墙上的数字 8421 与生锈钥匙。\n\n' +
      '【建议的下一步】\n1. 前往地下室铁门\n2. 尝试输入 8421\n\n' +
      '【针对问题的具体解答】\n密码锁可以直接使用 8421 解开，无需额外工具。';

    const responseData = {
      model: 'gpt-4o',
      choices: [
        {
          message: {
            content: answerContent
          }
        }
      ],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 80,
        total_tokens: 280
      }
    };
    return {
      status: 200,
      text: JSON.stringify(responseData),
      json: responseData
    };
  });

  const client = createAiClient({
    http,
    getSettings: async () => createMockSettings()
  });

  const extractRes = await client.extractClues('墙上写着 8421');
  assert.equal(extractRes.clues.length, 1);
  assert.equal(extractRes.clues[0].text, '墙上写着密码 8421');
  assert.deepEqual(extractRes.clues[0].tags, ['密码', '重要']);
  assert.equal(extractRes.clues[0].source, 'text');
  assert.deepEqual(extractRes.usage, {
    promptTokens: 120,
    completionTokens: 30,
    totalTokens: 150
  });

  // 请求校验：headers 携带密钥，URL 不含密钥
  assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.ok(!requests[0].url.includes(MOCK_API_KEY));
  assert.equal(
    requests[0].init.headers['Authorization'],
    `Bearer ${MOCK_API_KEY}`
  );

  const answerRes = await client.answerQuestion('怎么开地下室门？', extractRes.clues);
  assert.ok(answerRes.summary.includes('8421'));
  assert.ok(answerRes.suggestions.length >= 2);
  assert.ok(answerRes.answer.includes('无需额外工具'));
  assert.deepEqual(answerRes.usage, {
    promptTokens: 200,
    completionTokens: 80,
    totalTokens: 280
  });
});

test('Gemini 适配器：专用鉴权头与 usageMetadata 映射', async () => {
  const requests = [];
  const http = createMockHttpAdapter(async (url, init) => {
    requests.push({ url, init });

    const responseData = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: '[{"text":"获得红宝石","tags":["物品"]}]'
              }
            ]
          }
        }
      ],
      usageMetadata: {
        promptTokenCount: 55,
        candidatesTokenCount: 15,
        totalTokenCount: 70
      }
    };

    return {
      status: 200,
      text: JSON.stringify(responseData),
      json: responseData
    };
  });

  const client = createAiClient({
    http,
    getSettings: async () =>
      createMockSettings({
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        baseUrl: 'https://generativelanguage.googleapis.com'
      })
  });

  const res = await client.extractClues('在抽屉发现一颗红宝石');
  assert.equal(res.clues.length, 1);
  assert.equal(res.clues[0].text, '获得红宝石');
  assert.deepEqual(res.usage, {
    promptTokens: 55,
    completionTokens: 15,
    totalTokens: 70
  });

  assert.ok(!requests[0].url.includes(MOCK_API_KEY));
  assert.equal(requests[0].init.headers['x-goog-api-key'], MOCK_API_KEY);
  assert.equal(requests[0].init.headers['Authorization'], undefined);
});

test('错误响应或返回内容泄漏密钥时触发安全拦截，且 JSON 解析失败友好报错', async () => {
  // 1. 响应体报错泄漏 apiKey
  const leakingHttp = createMockHttpAdapter(async () => {
    return {
      status: 401,
      text: `{"error":{"message":"Invalid key: ${MOCK_API_KEY}"}}`,
      json: {
        error: {
          message: `Invalid key: ${MOCK_API_KEY}`
        }
      }
    };
  });

  const leakingClient = createAiClient({
    http: leakingHttp,
    getSettings: async () => createMockSettings()
  });

  await assert.rejects(
    async () => {
      await leakingClient.extractClues('一段新线索');
    },
    (err) => {
      assert.equal(err.message, '严重安全违规：文本中侦测到 API Key 泄漏风险');
      assert.ok(!err.message.includes(MOCK_API_KEY));
      return true;
    }
  );

  // 2. 响应成功但返回的 model 文本中含有 apiKey
  const textLeakingHttp = createMockHttpAdapter(async () => {
    const data = {
      choices: [
        {
          message: {
            content: `你的秘钥是 ${MOCK_API_KEY}`
          }
        }
      ]
    };
    return {
      status: 200,
      text: JSON.stringify(data),
      json: data
    };
  });

  const textLeakingClient = createAiClient({
    http: textLeakingHttp,
    getSettings: async () => createMockSettings()
  });

  await assert.rejects(
    async () => {
      await textLeakingClient.answerQuestion('我的配置是什么？');
    },
    (err) => {
      assert.equal(err.message, '严重安全违规：文本中侦测到 API Key 泄漏风险');
      return true;
    }
  );

  // 3. 响应非 JSON 字符串，抛出友好中文错误
  const malformedHttp = createMockHttpAdapter(async () => {
    return {
      status: 200,
      text: '<html>502 Bad Gateway</html>'
    };
  });

  const malformedClient = createAiClient({
    http: malformedHttp,
    getSettings: async () => createMockSettings()
  });

  await assert.rejects(
    async () => {
      await malformedClient.extractClues('线索信息');
    },
    {
      name: 'Error',
      message: '接口响应不是合法的 JSON，请稍后重试'
    }
  );
});
