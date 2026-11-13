// 职责：校验内容脚本注入清单与脚本形态，防止经典脚本出现静态导入
// 作者：Banana

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootUrl = new URL('../', import.meta.url);

const STATIC_IMPORT_PATTERNS = [
  /^\s*import\s+[^(\s]/,
  /^\s*import\s*\{/,
  /^\s*export\s/
];

function resolveUrl(relativePath) {
  return new URL(relativePath, rootUrl);
}

function readSource(relativePath) {
  return fs.readFileSync(resolveUrl(relativePath), 'utf8');
}

function fileExists(relativePath) {
  return fs.existsSync(resolveUrl(relativePath));
}

function findStaticImportLines(source) {
  const offenders = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (STATIC_IMPORT_PATTERNS.some((pattern) => pattern.test(lines[i]))) {
      offenders.push({ line: i + 1, text: lines[i] });
    }
  }
  return offenders;
}

function extractInjectedFiles() {
  const source = readSource('background/service-worker.js');
  const start = source.search(/\bregisterContentScripts\b/);
  assert.ok(start >= 0, '后台应调用 registerContentScripts');
  const match = source.slice(start).match(/js:\s*\[([^\]]*)\]/);
  assert.ok(match, 'registerContentScripts 调用中应包含 js 列表');
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
}

function collectRelativeImports(relativePath) {
  const source = readSource(relativePath);
  const dir = path.posix.dirname(relativePath);
  const result = [];
  const pattern = /^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm;
  let match = pattern.exec(source);
  while (match) {
    if (match[1].startsWith('.')) {
      result.push(path.posix.normalize(path.posix.join(dir, match[1])));
    }
    match = pattern.exec(source);
  }
  return result;
}

test('后台注入的内容脚本存在且不含顶层静态 import/export', () => {
  const files = extractInjectedFiles();
  assert.ok(files.length >= 1, '注入列表至少包含 1 个文件');
  for (const file of files) {
    assert.ok(fileExists(file), `注入的脚本文件应存在：${file}`);
    const offenders = findStaticImportLines(readSource(file));
    assert.equal(
      offenders.length,
      0,
      `经典内容脚本 ${file} 不应包含顶层静态 import/export，问题行：${offenders.map((item) => item.line).join(', ')}`
    );
  }
});

test('后台注入列表不再直接注入 content/reader.js', () => {
  const files = extractInjectedFiles();
  assert.ok(!files.includes('content/reader.js'), 'reader.js 是 ES 模块，不应被直接注入为经典脚本');
});

test('reader-loader.js 通过动态 import 加载 reader 模块', () => {
  const source = readSource('content/reader-loader.js');
  assert.ok(source.includes('import('), '加载器应使用动态 import()');
  assert.ok(
    source.includes("chrome.runtime.getURL('content/reader.js')"),
    '加载器应通过 chrome.runtime.getURL 定位 reader 模块'
  );
});

test('manifest 的 web_accessible_resources 覆盖 reader 及其静态依赖，且不得开启 use_dynamic_url', () => {
  const manifest = JSON.parse(readSource('manifest.json'));
  const entries = Array.isArray(manifest.web_accessible_resources) ? manifest.web_accessible_resources : [];
  assert.ok(entries.length >= 1, 'manifest 应声明 web_accessible_resources');

  const resources = new Set();
  for (const entry of entries) {
    // use_dynamic_url 为 true 时，getURL 会返回动态 UUID，而 reader.js 内的相对导入会落到真实扩展 ID 或 chrome-extension://invalid/ 导致模块加载失败
    assert.notEqual(entry.use_dynamic_url, true, 'web_accessible_resources 条目不得开启 use_dynamic_url');
    const list = entry && Array.isArray(entry.resources) ? entry.resources : [];
    for (const item of list) resources.add(item);
    const matches = entry && Array.isArray(entry.matches) ? entry.matches : [];
    assert.ok(!matches.includes('<all_urls>'), 'web_accessible_resources 的 matches 不应使用 <all_urls>');
  }

  const needed = ['content/reader.js', ...collectRelativeImports('content/reader.js')];
  for (const item of needed) {
    assert.ok(resources.has(item), `web_accessible_resources 应包含 ${item}`);
  }
});

test('service-worker.js 源码包含向已打开标签页补注入 reader-loader 的 executeScript 逻辑', () => {
  const source = readSource('background/service-worker.js');
  assert.ok(source.includes('chrome.scripting.executeScript'), 'service-worker 应包含 executeScript 调用');
  assert.ok(source.includes('content/reader-loader.js'), 'service-worker 注入文件应包含 content/reader-loader.js');
});

test('manifest 的 content_scripts 声明的脚本不含顶层静态 import/export', () => {
  const manifest = JSON.parse(readSource('manifest.json'));
  const entries = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  for (const entry of entries) {
    const js = entry && Array.isArray(entry.js) ? entry.js : [];
    for (const file of js) {
      assert.ok(fileExists(file), `content_scripts 文件应存在：${file}`);
      const offenders = findStaticImportLines(readSource(file));
      assert.equal(
        offenders.length,
        0,
        `content_scripts ${file} 不应包含顶层静态 import/export，问题行：${offenders.map((item) => item.line).join(', ')}`
      );
    }
  }
});
