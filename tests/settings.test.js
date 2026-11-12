// 职责：Settings 模块与权限管理服务的单元测试
// 作者：Allen

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOrigin,
  redactSecret,
  createSettingsService,
  DEFAULT_SETTINGS
} from '../core/settings.js';
import { createMemoryStorageAdapter } from '../adapters/storage.js';

test('normalizeOrigin 正常解析与非法输入校验', () => {
  assert.equal(
    normalizeOrigin('https://example.com/sub/path?foo=1#hash'),
    'https://example.com'
  );

  assert.equal(
    normalizeOrigin('http://localhost:8080/test/'),
    'http://localhost:8080'
  );

  assert.equal(
    normalizeOrigin('puzzle.game.io'),
    'https://puzzle.game.io'
  );

  assert.throws(() => {
    normalizeOrigin('');
  }, /无效的 URL 格式，请输入正确的网址/);

  assert.throws(() => {
    normalizeOrigin('not-a-valid-domain:::');
  }, /无效的 URL 格式，请输入正确的网址/);

  assert.throws(() => {
    normalizeOrigin(null);
  }, /无效的 URL 格式，请输入正确的网址/);
});

test('redactSecret 脱敏规则校验', () => {
  assert.equal(redactSecret(''), '');
  assert.equal(redactSecret(null), '');
  assert.equal(redactSecret(undefined), '');

  // 长度 < 8 为 ****
  assert.equal(redactSecret('1234567'), '****');
  assert.equal(redactSecret('short'), '****');

  // 长度 >= 8 为 前3 + **** + 后4
  assert.equal(redactSecret('12345678'), '123****5678');
  assert.equal(redactSecret('sk-test-key-ABCDEFGH'), 'sk-****EFGH');
});

test('saveSettings 与 getSettings 读写', async () => {
  const storage = createMemoryStorageAdapter();
  const service = createSettingsService({ storage, permissions: {} });

  const initial = await service.getSettings();
  assert.equal(initial.provider, DEFAULT_SETTINGS.provider);
  assert.equal(initial.apiKey, '');

  await service.saveSettings({
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKey: 'sk-secret-token-123456'
  });

  const updated = await service.getSettings();
  assert.equal(updated.provider, 'deepseek');
  assert.equal(updated.model, 'deepseek-chat');
  assert.equal(updated.apiKey, 'sk-secret-token-123456');
});

test('getRedactedSettings 返回脱敏结果且绝不包含明文密钥', async () => {
  const storage = createMemoryStorageAdapter();
  const service = createSettingsService({ storage, permissions: {} });

  const secretPlain = 'sk-test-key-ABCDEFGH';
  await service.saveSettings({
    apiKey: secretPlain
  });

  const redacted = await service.getRedactedSettings();
  assert.equal(redacted.hasApiKey, true);
  assert.equal(redacted.apiKeyMasked, 'sk-****EFGH');
  assert.equal(redacted.apiKey, undefined);

  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(secretPlain), false);
});

test('addGameSite 与 removeGameSite 动态权限与注销校验', async () => {
  const storage = createMemoryStorageAdapter();
  const calls = {
    requestedOrigins: [],
    registeredReaders: [],
    unregisteredReaders: [],
    removedOrigins: []
  };

  let grantNext = false;
  const mockPermissions = {
    async requestOrigin(origin) {
      calls.requestedOrigins.push(origin);
      return grantNext;
    },
    async registerReader(origin) {
      calls.registeredReaders.push(origin);
    },
    async unregisterReader(origin) {
      calls.unregisteredReaders.push(origin);
    },
    async removeOrigin(origin) {
      calls.removedOrigins.push(origin);
    }
  };

  const service = createSettingsService({ storage, permissions: mockPermissions });

  // 1. 拒绝授权时 granted 为 false 仍写入列表
  grantNext = false;
  const addResultDenied = await service.addGameSite('https://game.example.com/play', 'game-1');
  assert.equal(addResultDenied.granted, false);
  assert.equal(addResultDenied.site.granted, false);
  assert.equal(calls.registeredReaders.length, 0);

  let currentSettings = await service.getSettings();
  assert.equal(currentSettings.gameSites.length, 1);
  assert.equal(currentSettings.gameSites[0].origin, 'https://game.example.com');
  assert.equal(currentSettings.gameSites[0].granted, false);

  // 2. 授权成功，注册同源但不同 gameId
  grantNext = true;
  await service.addGameSite('https://game.example.com/level2', 'game-2');
  assert.equal(calls.registeredReaders.includes('https://game.example.com'), true);

  currentSettings = await service.getSettings();
  assert.equal(currentSettings.gameSites.length, 2);

  // 3. 移除 game-1，同源仍有 game-2，不应注销 origin
  await service.removeGameSite('https://game.example.com', 'game-1');
  assert.equal(calls.unregisterReader.length, 0);
  assert.equal(calls.removedOrigins.length, 0);

  // 4. 移除最后一个同源站点 game-2，调用注销与移除
  await service.removeGameSite('https://game.example.com', 'game-2');
  assert.equal(calls.unregisteredReaders.includes('https://game.example.com'), true);
  assert.equal(calls.removedOrigins.includes('https://game.example.com'), true);

  const finalSettings = await service.getSettings();
  assert.equal(finalSettings.gameSites.length, 0);
});

test('requestProviderHostPermission 域名推导校验', async () => {
  const storage = createMemoryStorageAdapter();
  const requestedPatterns = [];

  const mockPermissions = {
    async requestHost(patterns) {
      requestedPatterns.push(...patterns);
      return true;
    }
  };

  const service = createSettingsService({ storage, permissions: mockPermissions });

  // openai_compatible 默认
  await service.requestProviderHostPermission('openai_compatible');
  assert.equal(requestedPatterns.pop(), 'https://api.openai.com/*');

  // openai_compatible 自定义 Base URL
  await service.requestProviderHostPermission('openai_compatible', 'https://custom-ai.internal:9000/v1');
  assert.equal(requestedPatterns.pop(), 'https://custom-ai.internal:9000/*');

  // deepseek
  await service.requestProviderHostPermission('deepseek');
  assert.equal(requestedPatterns.pop(), 'https://api.deepseek.com/*');

  // gemini
  await service.requestProviderHostPermission('gemini');
  assert.equal(requestedPatterns.pop(), 'https://generativelanguage.googleapis.com/*');

  // 未知服务商异常
  await assert.rejects(async () => {
    await service.requestProviderHostPermission('unknown_provider');
  }, /未知的服务商类型/);
});
