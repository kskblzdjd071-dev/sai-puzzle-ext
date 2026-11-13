import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDelta,
  collectVisibleText,
  shouldCaptureCanvas,
  flushBatch,
  stopReader
} from '../content/reader.js';

function createNode(tagOrType, attrs = {}) {
  if (tagOrType === '#text') {
    return {
      nodeType: 3,
      nodeValue: attrs.nodeValue || '',
      firstChild: null,
      nextSibling: null
    };
  }

  const node = {
    nodeType: 1,
    tagName: tagOrType.toUpperCase(),
    style: attrs.style || {},
    attributes: { ...(attrs.attributes || {}) },
    firstChild: null,
    nextSibling: null,
    clientWidth: attrs.clientWidth || 0,
    clientHeight: attrs.clientHeight || 0,
    width: attrs.width || 0,
    height: attrs.height || 0,
    getAttribute(name) {
      return this.attributes[name] !== undefined ? this.attributes[name] : null;
    },
    setAttribute(name, val) {
      this.attributes[name] = String(val);
    },
    appendChild(child) {
      if (!this.firstChild) {
        this.firstChild = child;
      } else {
        let cur = this.firstChild;
        while (cur.nextSibling) {
          cur = cur.nextSibling;
        }
        cur.nextSibling = child;
      }
      return child;
    }
  };

  if (attrs.role) {
    node.setAttribute('role', attrs.role);
  }

  return node;
}

function createTextNode(text) {
  return createNode('#text', { nodeValue: text });
}

function createDocStub(rootElement, options = {}) {
  const doc = {
    nodeType: 9,
    documentElement: {
      clientWidth: options.viewportWidth || 1000,
      clientHeight: options.viewportHeight || 800
    },
    body: rootElement,
    defaultView: {
      innerWidth: options.viewportWidth || 1000,
      innerHeight: options.viewportHeight || 800,
      getComputedStyle(elem) {
        return elem.style || {};
      }
    },
    querySelectorAll(selector) {
      const results = [];
      const targetTag = selector.toUpperCase();

      function walk(curr) {
        if (!curr || curr.nodeType !== 1) return;
        if (curr.tagName === targetTag) {
          results.push(curr);
        }
        let c = curr.firstChild;
        while (c) {
          walk(c);
          c = c.nextSibling;
        }
      }

      walk(rootElement);
      return results;
    }
  };
  return doc;
}

test('computeDelta: 前缀增量、包含子串、无新增及边界测试', () => {
  // 1. 前缀增量提取
  assert.equal(
    computeDelta('勇者来到了城堡大门。', '勇者来到了城堡大门。大门缓缓打开。'),
    '大门缓缓打开。'
  );

  // 2. 包含子串（前缀有些许偏移但包含完整旧文本）
  assert.equal(
    computeDelta('第二章', '目录 第一章 第二章 序幕拉开'),
    '序幕拉开'
  );

  // 3. 无新增返回空字符串
  assert.equal(computeDelta('完全一致的内容', '完全一致的内容'), '');

  // 4. null / undefined 当空串处理
  assert.equal(computeDelta(null, '首次获取的正文内容'), '首次获取的正文内容');
  assert.equal(computeDelta(undefined, '正文'), '正文');
  assert.equal(computeDelta('旧内容', null), '');
  assert.equal(computeDelta('旧内容', undefined), '');

  // 5. 空白折叠后无实质变化返回空字符串
  assert.equal(computeDelta('文本 换行 内容', '文本   \n\t  换行   内容'), '');

  // 6. 整页刷新/局部重排只返回新增段落
  const prevParagraphs = '第一段已经结束。第二段也结束了。';
  const nextParagraphs = '第一段已经结束。第二段也结束了。第三段出现了。第四段紧随其后。';
  const delta = computeDelta(prevParagraphs, nextParagraphs);
  assert.ok(delta.includes('第三段出现了。'));
  assert.ok(delta.includes('第四段紧随其后。'));
  assert.ok(!delta.includes('第一段已经结束。'));

  // 7. 仅数字与时间/倒计时变动时应返回空串
  assert.equal(
    computeDelta('房间里有一扇门。剩余时间 01:30', '房间里有一扇门。剩余时间 01:29'),
    ''
  );
  assert.equal(computeDelta('冷却 5s', '冷却 4s'), '');
  assert.equal(computeDelta('分数 100 倒计时 10', '分数 105 倒计时 09'), '');

  // 8. 出现真正新文本（即使含有数字）时仍应返回非空增量且包含新文本
  const deltaWithNewText = computeDelta(
    '房间里有一扇门。剩余时间 01:30',
    '房间里有一扇门。剩余时间 01:29 墙上写着密码是 4312'
  );
  assert.notEqual(deltaWithNewText, '');
  assert.ok(deltaWithNewText.includes('密码是 4312'));
});

test('collectVisibleText: 跳过插件自身的 UI (data-sai-ext)', () => {
  const body = createNode('body');

  const mainP = createNode('p');
  mainP.appendChild(createTextNode('解谜核心正文'));
  body.appendChild(mainP);

  const extBtn = createNode('button', {
    attributes: { 'data-sai-ext': '1' }
  });
  extBtn.appendChild(createTextNode('冷却 5s'));
  body.appendChild(extBtn);

  const extContainer = createNode('div', {
    attributes: { 'data-sai-ext': 'screenshot-host' }
  });
  const extChild = createNode('span');
  extChild.appendChild(createTextNode('发送截图解谜'));
  extContainer.appendChild(extChild);
  body.appendChild(extContainer);

  const doc = createDocStub(body);
  const collected = collectVisibleText(doc);

  assert.ok(collected.includes('解谜核心正文'));
  assert.ok(!collected.includes('冷却 5s'));
  assert.ok(!collected.includes('发送截图解谜'));
  assert.equal(collected, '解谜核心正文');
});

test('发送路径零调用测试：仅计时器数字或插件 UI 变化不得触发 sendMessage', () => {
  stopReader();

  const body = createNode('body');

  const textNode = createTextNode('房间里有一扇门。剩余时间 01:30');
  const gameParagraph = createNode('p');
  gameParagraph.appendChild(textNode);
  body.appendChild(gameParagraph);

  const pluginBtnText = createTextNode('冷却 5s');
  const pluginBtn = createNode('button', {
    attributes: { 'data-sai-ext': '1' }
  });
  pluginBtn.appendChild(pluginBtnText);
  body.appendChild(pluginBtn);

  const mockDoc = createDocStub(body);

  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;

  globalThis.document = mockDoc;
  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') {
          cb();
        }
      }
    }
  };

  try {
    // 第一次冲刷：初始有正文，应发送 1 次初始增量
    flushBatch(true);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].payload.text.includes('房间里有一扇门'));
    assert.ok(!sentMessages[0].payload.text.includes('冷却 5s'));

    // 仅修改插件自身按钮文案
    pluginBtnText.nodeValue = '冷却 4s';
    flushBatch(true);
    assert.equal(sentMessages.length, 1, '仅插件按钮文案变化时 sendMessage 不得新增调用');

    // 仅修改游戏内倒计时数字
    textNode.nodeValue = '房间里有一扇门。剩余时间 01:29';
    flushBatch(true);
    assert.equal(sentMessages.length, 1, '仅游戏计时器数字变化时 sendMessage 不得新增调用');

    // 当追加真正的新游戏文本时应触发发送
    const newParagraph = createNode('p');
    newParagraph.appendChild(createTextNode('墙上出现密码 4312'));
    body.appendChild(newParagraph);
    flushBatch(true);

    assert.equal(sentMessages.length, 2, '追加有意义新文本后应触发发送');
    const latestPayload = sentMessages[1].payload.text;
    assert.ok(latestPayload.includes('墙上出现密码 4312'));
    assert.ok(!latestPayload.includes('冷却'));
  } finally {
    stopReader();
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }
});

test('collectVisibleText: 标签过滤、样式隐藏、role过滤与保留普通header', () => {
  const body = createNode('body');

  // 1. 普通 header 文本（非 fixed/sticky）应被保留
  const normalHeader = createNode('header');
  normalHeader.appendChild(createTextNode('游戏顶部状态栏'));
  body.appendChild(normalHeader);

  // 2. fixed 的 nav 应跳过
  const fixedNav = createNode('nav', { style: { position: 'fixed' } });
  fixedNav.appendChild(createTextNode('固定的导航菜单'));
  body.appendChild(fixedNav);

  // 3. role=navigation 且 style.position=sticky 应跳过
  const stickyRoleNav = createNode('div', {
    role: 'navigation',
    style: { position: 'sticky' }
  });
  stickyRoleNav.appendChild(createTextNode('粘性导航'));
  body.appendChild(stickyRoleNav);

  // 4. script / style / noscript / iframe / svg 应被跳过
  const scriptElem = createNode('script');
  scriptElem.appendChild(createTextNode('console.log("hide");'));
  body.appendChild(scriptElem);

  const svgElem = createNode('svg');
  svgElem.appendChild(createTextNode('矢量图形文本'));
  body.appendChild(svgElem);

  // 5. display: none / visibility: hidden 应跳过
  const hiddenDiv = createNode('div', { style: { display: 'none' } });
  hiddenDiv.appendChild(createTextNode('隐藏正文1'));
  body.appendChild(hiddenDiv);

  const invisibleDiv = createNode('div', { style: { visibility: 'hidden' } });
  invisibleDiv.appendChild(createTextNode('隐藏正文2'));
  body.appendChild(invisibleDiv);

  // 6. 正常正文与多空格文本
  const mainArticle = createNode('main');
  mainArticle.appendChild(createTextNode('   正文   段落一   \n\t   内容   '));
  body.appendChild(mainArticle);

  const doc = createDocStub(body);
  const collected = collectVisibleText(doc);

  assert.ok(collected.includes('游戏顶部状态栏'));
  assert.ok(!collected.includes('固定的导航菜单'));
  assert.ok(!collected.includes('粘性导航'));
  assert.ok(!collected.includes('console.log'));
  assert.ok(!collected.includes('矢量图形文本'));
  assert.ok(!collected.includes('隐藏正文1'));
  assert.ok(!collected.includes('隐藏正文2'));
  assert.ok(collected.includes('正文 段落一 内容'));
  // 确认多余空白被折叠
  assert.equal(collected, '游戏顶部状态栏 正文 段落一 内容');
});

test('shouldCaptureCanvas: 尺寸判定与视口面积占比判定', () => {
  // 1. 无 canvas 返回 false
  const emptyBody = createNode('body');
  const emptyDoc = createDocStub(emptyBody);
  assert.equal(shouldCaptureCanvas(emptyDoc), false);

  // 2. 宽高 > 300x200 为 true
  const body1 = createNode('body');
  const cvs1 = createNode('canvas', { clientWidth: 320, clientHeight: 240 });
  body1.appendChild(cvs1);
  const doc1 = createDocStub(body1, { viewportWidth: 1920, viewportHeight: 1080 });
  assert.equal(shouldCaptureCanvas(doc1), true);

  // 3. 面积占视口 30% 以上为 true（即使尺寸略小于 300x200，如在小屏幕或小视口下）
  // 视口：500x300 = 150000 像素，30% 为 45000 像素
  // 画布：280x180 = 50400 像素 (宽<300且高<200，但占比 33.6% >= 30%)
  const body2 = createNode('body');
  const cvs2 = createNode('canvas', { clientWidth: 280, clientHeight: 180 });
  body2.appendChild(cvs2);
  const doc2 = createDocStub(body2, { viewportWidth: 500, viewportHeight: 300 });
  assert.equal(shouldCaptureCanvas(doc2), true);

  // 4. 过小且不够 30% 为 false
  // 视口 1000x800 = 800000 像素
  // 画布 100x100 = 10000 像素 (占比 1.25%)
  const body3 = createNode('body');
  const cvs3 = createNode('canvas', { clientWidth: 100, clientHeight: 100 });
  body3.appendChild(cvs3);
  const doc3 = createDocStub(body3, { viewportWidth: 1000, viewportHeight: 800 });
  assert.equal(shouldCaptureCanvas(doc3), false);
});
