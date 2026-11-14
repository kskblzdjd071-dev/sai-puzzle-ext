import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDelta,
  collectVisibleText,
  shouldCaptureCanvas,
  capturePrimaryCanvasImage,
  flushBatch,
  stopReader,
  startReader,
  getNumericSlotTrackerSize,
  NUMERIC_SLOT_TRACKER_LIMIT
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
    '目录 第一章 序幕拉开'
  );

  assert.ok(
    computeDelta('旧消息一。旧消息二。', '新提示：去 3 楼。旧消息一。旧消息二。').includes('新提示：去 3 楼')
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

  // 7. 仅时间/倒计时变动时应返回空串；普通单次数字变化返回非空且包含新数字
  assert.equal(
    computeDelta('房间里有一扇门。剩余时间 01:30', '房间里有一扇门。剩余时间 01:29'),
    ''
  );
  assert.equal(computeDelta('冷却 5s', '冷却 4s'), '');
  assert.equal(computeDelta('00:59', '00:58'), '');
  assert.equal(computeDelta('倒计时 10', '倒计时 09'), '');

  const scoreDelta = computeDelta('分数 100', '分数 105');
  assert.notEqual(scoreDelta, '');
  assert.ok(scoreDelta.includes('105'));

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
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  let fakeNow = 10000;
  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

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
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // startReader 已把当前可见文本写入 previousText，页面未变化时首次 interval 冲刷必须 0 次发送
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0, '首次 interval 冲刷不应发送任何消息');

    // 仅修改插件自身按钮文案
    fakeNow += 5000;
    pluginBtnText.nodeValue = '冷却 4s';
    batchTimer.fn();
    assert.equal(sentMessages.length, 0, '仅插件按钮文案变化时 sendMessage 不得新增调用');

    // 仅修改游戏内倒计时数字
    fakeNow += 5000;
    textNode.nodeValue = '房间里有一扇门。剩余时间 01:29';
    batchTimer.fn();
    assert.equal(sentMessages.length, 0, '仅游戏计时器数字变化时 sendMessage 不得新增调用');

    // 当追加真正的新游戏文本时应触发发送
    const newParagraph = createNode('p');
    newParagraph.appendChild(createTextNode('墙上出现密码 4312'));
    body.appendChild(newParagraph);
    fakeNow += 5000;
    batchTimer.fn();

    assert.equal(sentMessages.length, 1, '追加有意义新文本后应触发发送');
    const latestPayload = sentMessages[0].payload.text;
    assert.ok(latestPayload.includes('墙上出现密码 4312'));
    assert.ok(!latestPayload.includes('冷却'));
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
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
  // 确认块级元素以换行分隔且多余空白被折叠
  assert.equal(collected, '游戏顶部状态栏\n正文 段落一 内容');
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

test('capturePrimaryCanvasImage 对合格 canvas 返回 mime 与 base64，对过小或报错 canvas 返回 null', async () => {
  const reader = await import('../content/reader.js');
  if (typeof reader.capturePrimaryCanvasImage !== 'function') {
    assert.fail('capturePrimaryCanvasImage 必须导出');
  }

  // 1. 合格画布且 toDataURL 正常
  const docValid = {
    defaultView: { innerWidth: 1000, innerHeight: 800 },
    querySelectorAll: (sel) => {
      if (sel === 'canvas') {
        return [
          {
            clientWidth: 400,
            clientHeight: 300,
            toDataURL: (type, q) => 'data:image/jpeg;base64,MOCK_IMAGE_DATA',
          },
        ];
      }
      return [];
    },
  };
  const validResult = reader.capturePrimaryCanvasImage(docValid);
  assert.deepEqual(validResult, {
    mimeType: 'image/jpeg',
    dataBase64: 'MOCK_IMAGE_DATA',
  });

  // 2. 过小画布
  const docSmall = {
    defaultView: { innerWidth: 1000, innerHeight: 800 },
    querySelectorAll: (sel) => {
      if (sel === 'canvas') {
        return [{ clientWidth: 100, clientHeight: 100, toDataURL: () => 'data:image/jpeg;base64,SMALL' }];
      }
      return [];
    },
  };
  const smallResult = reader.capturePrimaryCanvasImage(docSmall);
  assert.equal(smallResult, null);

  // 3. toDataURL 抛错（如被污染）
  const docTainted = {
    defaultView: { innerWidth: 1000, innerHeight: 800 },
    querySelectorAll: (sel) => {
      if (sel === 'canvas') {
        return [
          {
            clientWidth: 400,
            clientHeight: 300,
            toDataURL: () => {
              throw new Error('SecurityError: Tainted canvas');
            },
          },
        ];
      }
      return [];
    },
  };
  const taintedResult = reader.capturePrimaryCanvasImage(docTainted);
  assert.equal(taintedResult, null);
});

test('规则验证 1 & 2: 页面新增密码发送，倒计时格式变动/停住均不补发', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');
  const timerNode = createTextNode('冷却 5s');
  const pTimer = createNode('p');
  pTimer.appendChild(timerNode);
  body.appendChild(pTimer);

  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // startReader 后页面未变，首次 tick 不发送
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 2. 仅「冷却 5s」->「冷却 4s」-> 零新增发送
    fakeNow += 5000;
    timerNode.nodeValue = '冷却 4s';
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 冻结倒计时停住超过 5 秒再 tick，也不得补发终值
    fakeNow += 6000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0, '冻结的倒计时不得补发终值');

    // 1. 页面新增「密码是 4271」-> send 次数增加且含 4271
    const pPassword = createNode('p');
    pPassword.appendChild(createTextNode('密码是 4271'));
    body.appendChild(pPassword);
    fakeNow += 5000;
    batchTimer.fn();

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].payload.text.includes('4271'));
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('规则验证 3: 保险箱密码单次变化必须发送并包含新值', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');
  const pSafe = createNode('p');
  const textNode = createTextNode('保险箱密码 4721');
  pSafe.appendChild(textNode);
  body.appendChild(pSafe);

  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // startReader 后页面未变，首次 tick 不发送
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 改成 9035
    fakeNow += 5000;
    textNode.nodeValue = '保险箱密码 9035';
    batchTimer.fn();

    assert.equal(sentMessages.length, 1, '保险箱密码单次变化应发送');
    assert.ok(sentMessages[0].payload.text.includes('9035'));
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('规则验证 4: 分数首次同位变化发送，快速3次变化判定跳动并抑制后续', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');
  const pScore = createNode('p');
  const scoreText = createTextNode('分数 100');
  pScore.appendChild(scoreText);
  body.appendChild(pScore);

  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // startReader 后页面未变，首次 tick 不发送
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 第一次变化：100 -> 105，必须发送
    fakeNow += 5000;
    scoreText.nodeValue = '分数 105';
    batchTimer.fn();
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].payload.text.includes('105'));

    // 第二次变化：105 -> 110，30s内第二次，发送
    fakeNow += 5000;
    scoreText.nodeValue = '分数 110';
    batchTimer.fn();
    assert.equal(sentMessages.length, 2);
    assert.ok(sentMessages[1].payload.text.includes('110'));

    // 第三次变化：110 -> 115，达到3次判定跳动，停止发送
    fakeNow += 5000;
    scoreText.nodeValue = '分数 115';
    batchTimer.fn();
    assert.equal(sentMessages.length, 2, '第3次同位变化判定跳动，不再发送');

    // 第四次变化：115 -> 120，继续抑制
    fakeNow += 5000;
    scoreText.nodeValue = '分数 120';
    batchTimer.fn();
    assert.equal(sentMessages.length, 2, '跳动状态下继续抑制');
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('规则验证 5: 跳动数字停止变化 >5 秒后补发终值，倒计时停止不补发', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');
  const pLock = createNode('p');
  const lockText = createTextNode('转盘密码 1');
  pLock.appendChild(lockText);
  body.appendChild(pLock);

  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // startReader 后页面未变，首次 tick 不发送
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 快速转动密码锁：1 -> 2 (变动1), 2 -> 3 (变动2), 3 -> 9 (变动3: 判跳动)
    fakeNow += 1000;
    lockText.nodeValue = '转盘密码 2';
    batchTimer.fn();
    assert.equal(sentMessages.length, 1);

    fakeNow += 1000;
    lockText.nodeValue = '转盘密码 3';
    batchTimer.fn();
    assert.equal(sentMessages.length, 2);

    fakeNow += 1000;
    lockText.nodeValue = '转盘密码 9';
    batchTimer.fn();
    assert.equal(sentMessages.length, 2, '第3次被判定跳动抑制');

    // 保持在 9，推进 4000ms（未超 5000ms），不补发
    fakeNow += 4000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 2);

    // 推进到累计超 5000ms (再加 2000ms，总间隔 6000ms > 5000ms)
    fakeNow += 2000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 3, '稳定 >5 秒后补发终值');
    assert.ok(sentMessages[2].payload.text.includes('9'));
    assert.equal(sentMessages[2].payload.text, '转盘密码 9');

    // 补发后再过 6 秒，不能重复补发
    fakeNow += 6000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 3, '终值补发后不得重复补发');

    // 补发后若单次再改到新值，按“第一次变化”处理，仍能发送
    fakeNow += 5000;
    lockText.nodeValue = '转盘密码 8';
    batchTimer.fn();
    assert.equal(sentMessages.length, 4, '清空跳动状态后单次新值可正常发送');
    assert.ok(sentMessages[3].payload.text.includes('8'));
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('场景验证：同时存在 mm:ss 计时与密码，时钟长跑零发送，密码变化单次发送', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');
  const timerP = createNode('p');
  const timerText = createTextNode('剩余 00:59 保险箱密码 4721');
  timerP.appendChild(timerText);
  body.appendChild(timerP);

  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // 启动初始 tick，文本基准确立
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 时钟连续走 6 次（跨度 30s）
    for (let i = 58; i >= 53; i--) {
      fakeNow += 5000;
      timerText.nodeValue = `剩余 00:${i} 保险箱密码 4721`;
      batchTimer.fn();
    }
    assert.equal(sentMessages.length, 0, '时钟连续倒计时变化不得触发发送');

    // 随后将密码改为 9035
    fakeNow += 5000;
    timerText.nodeValue = '剩余 00:52 保险箱密码 9035';
    batchTimer.fn();

    assert.equal(sentMessages.length, 1, '密码修改后恰好发送 1 次');
    assert.ok(sentMessages[0].payload.text.includes('9035'));
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('容量验证：大量不同局部句子数字变化触发追踪器 LRU 上限限制', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');
  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // 连续生成并变动超过 250 个不同句子/位置
    for (let i = 0; i < 250; i++) {
      const p = createNode('p');
      p.appendChild(createTextNode(`任务编号${i}：当前数值 ${i}`));
      body.appendChild(p);

      fakeNow += 100;
      batchTimer.fn();
    }

    assert.ok(getNumericSlotTrackerSize() <= NUMERIC_SLOT_TRACKER_LIMIT);
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('同模板原文：依次追加同模板线索各以原文发出且不被历史篡改', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');
  const p1 = createNode('p');
  p1.appendChild(createTextNode('密码第 1 位是 7。'));
  body.appendChild(p1);

  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // startReader 后首次 tick 发送次数为 0
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 追加第 2 位
    const p2 = createNode('p');
    p2.appendChild(createTextNode('密码第 2 位是 3。'));
    body.appendChild(p2);
    fakeNow += 5000;
    batchTimer.fn();

    // 追加第 3 位
    const p3 = createNode('p');
    p3.appendChild(createTextNode('密码第 3 位是 9。'));
    body.appendChild(p3);
    fakeNow += 5000;
    batchTimer.fn();

    // 追加第 4 位
    const p4 = createNode('p');
    p4.appendChild(createTextNode('密码第 4 位是 1。'));
    body.appendChild(p4);
    fakeNow += 5000;
    batchTimer.fn();

    assert.equal(sentMessages.length, 3);
    assert.ok(sentMessages[0].payload.text.includes('第 2 位是 3'));
    assert.ok(sentMessages[1].payload.text.includes('第 3 位是 9'));
    assert.ok(sentMessages[2].payload.text.includes('第 4 位是 1'));

    // 任何一次 payload.text 都不得把后出现的句子改写成「第 1 位是 7」
    assert.ok(sentMessages[1].payload.text.includes('9'));
    assert.notEqual(sentMessages[1].payload.text.trim(), '密码第 1 位是 7。');
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('补发与新内容合并：密码连续变化后延迟补发与新内容合并在同一次发送', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');
  const pLock = createNode('p');
  const textNode = createTextNode('转盘密码 1');
  pLock.appendChild(textNode);
  body.appendChild(pLock);

  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // 首次静息无发送
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 转盘密码 1 -> 2 (发送次数 1)
    fakeNow += 1000;
    textNode.nodeValue = '转盘密码 2';
    batchTimer.fn();
    assert.equal(sentMessages.length, 1);

    // 转盘密码 2 -> 3 (发送次数 2)
    fakeNow += 1000;
    textNode.nodeValue = '转盘密码 3';
    batchTimer.fn();
    assert.equal(sentMessages.length, 2);

    // 转盘密码 3 -> 9 (第 3 次变化被抑制，发送次数仍为 2)
    fakeNow += 1000;
    textNode.nodeValue = '转盘密码 9';
    batchTimer.fn();
    assert.equal(sentMessages.length, 2);

    // 不改密码，间隔超过 5000ms，tick 前追加「门开了。」
    fakeNow += 6000;
    const pDoor = createNode('p');
    pDoor.appendChild(createTextNode('门开了。'));
    body.appendChild(pDoor);
    batchTimer.fn();

    assert.equal(sentMessages.length, 3);
    const lastPayload = sentMessages[2].payload.text;
    assert.ok(lastPayload.includes('转盘密码 9'), '必须包含完整原句「转盘密码 9」');
    assert.ok(lastPayload.includes('门开了。'), '必须包含新追加的「门开了。」');
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('滚动 3 行日志：同模板滚动删除顶部行并追加底部行时，每一个新回合均正常发出', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');

  function makeRoundNode(round, coins) {
    const p = createNode('p');
    p.appendChild(createTextNode(`第 ${round} 回合：获得 ${coins} 枚金币。`));
    return p;
  }

  // 初始 3 行
  body.appendChild(makeRoundNode(1, 10));
  body.appendChild(makeRoundNode(2, 20));
  body.appendChild(makeRoundNode(3, 30));

  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // 首次 tick：静息无发送
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 滚动 12 次：删掉最上面一行，底部追加新回合
    for (let r = 4; r <= 15; r++) {
      fakeNow += 1000;
      // 移除 body.firstChild
      body.firstChild = body.firstChild.nextSibling;
      // 追加新行
      const newCoins = r * 10;
      body.appendChild(makeRoundNode(r, newCoins));

      batchTimer.fn();

      const expectedSentCount = r - 3;
      assert.equal(sentMessages.length, expectedSentCount, `第 ${r} 回合发送次数应为 ${expectedSentCount}`);
      const latestMsg = sentMessages[sentMessages.length - 1];
      const expectedText = `第 ${r} 回合：获得 ${newCoins} 枚金币。`;
      assert.ok(latestMsg.payload.text.includes(expectedText), `第 ${r} 回合未在 payload 中找到：${latestMsg.payload.text}`);
    }

    // 滚动结束后再静置 tick 一次，确认没有多余的裸数字补发
    fakeNow += 6000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 12, '滚动结束后无额外裸数字发送');
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('最新在上滚动 3 行日志：删底部、顶部插入时，每一个新回合均正常发出', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');

  function makeRoundNode(round, coins) {
    const p = createNode('p');
    p.appendChild(createTextNode(`第 ${round} 回合：获得 ${coins} 枚金币。`));
    return p;
  }

  // 初始 3 行
  body.appendChild(makeRoundNode(1, 10));
  body.appendChild(makeRoundNode(2, 20));
  body.appendChild(makeRoundNode(3, 30));

  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // 首次 tick：静息无发送
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 滚动 12 次：删掉最后一行，在顶部插入新回合节点
    for (let r = 4; r <= 15; r++) {
      fakeNow += 1000;
      // 删底部：找到倒数第二个节点，将 nextSibling 置为 null
      let curr = body.firstChild;
      if (!curr || !curr.nextSibling) {
        body.firstChild = null;
      } else {
        while (curr.nextSibling && curr.nextSibling.nextSibling) {
          curr = curr.nextSibling;
        }
        curr.nextSibling = null;
      }

      // 顶部插入新行
      const newCoins = r * 10;
      const newNode = makeRoundNode(r, newCoins);
      newNode.nextSibling = body.firstChild;
      body.firstChild = newNode;

      batchTimer.fn();

      const expectedSentCount = r - 3;
      assert.equal(sentMessages.length, expectedSentCount, `第 ${r} 回合发送次数应为 ${expectedSentCount}`);
      const latestMsg = sentMessages[sentMessages.length - 1];
      const expectedText = `第 ${r} 回合：获得 ${newCoins} 枚金币。`;
      assert.ok(latestMsg.payload.text.includes(expectedText), `第 ${r} 回合未在 payload 中找到：${latestMsg.payload.text}`);
    }

    // 滚动结束后再静置 tick 一次，确认没有多余的裸数字补发
    fakeNow += 6000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 12, '滚动结束后无额外裸数字发送');
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('打满容量不持续发送：大量静态句子后高频计数变化被抑制且追踪器不超限', () => {
  stopReader();

  let fakeNow = 10000;
  const sentMessages = [];
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const intervals = new Map();
  let nextId = 1;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') cb();
      }
    }
  };

  const body = createNode('body');
  for (let i = 0; i < 250; i++) {
    const p = createNode('p');
    p.appendChild(createTextNode(`编号 ${i}：位置 ${i}`));
    body.appendChild(p);
  }

  const mockDoc = createDocStub(body);
  globalThis.document = mockDoc;

  try {
    startReader({ now: () => fakeNow, batchIntervalMs: 5000 });
    const batchTimer = Array.from(intervals.values()).find(t => t.ms === 5000);

    // 首次 tick 纳入静态项，不应持续发送
    fakeNow += 5000;
    batchTimer.fn();
    assert.equal(sentMessages.length, 0);

    // 添加「计数 1」
    const pCount = createNode('p');
    const countTextNode = createTextNode('计数 1');
    pCount.appendChild(countTextNode);
    body.appendChild(pCount);

    // 快速将计数由 2 改到 12（11 次变化，每 1000ms 一次，落在 30 秒窗口内）
    for (let c = 2; c <= 12; c++) {
      fakeNow += 1000;
      countTextNode.nodeValue = `计数 ${c}`;
      batchTimer.fn();
    }

    assert.ok(sentMessages.length <= 3, `发送次数应该远小于 12，实际为 ${sentMessages.length}`);
    assert.ok(getNumericSlotTrackerSize() <= NUMERIC_SLOT_TRACKER_LIMIT);
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('稳定补发只使用被跟踪项自己的句子，不借用页上同数字的其他句子', async () => {
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  try {
    let now = 100000;
    const intervals = [];
    globalThis.setInterval = (fn, ms) => {
      const timer = { fn, ms, id: intervals.length + 1 };
      intervals.push(timer);
      return timer.id;
    };
    globalThis.clearInterval = () => {};

    const sent = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: (...args) => { sent.push(args[0]); },
        onMessage: { addListener: () => {} },
      },
    };

    const body = createNode('body');
    const doc = createDocStub(body);
    globalThis.document = doc;

    const makeP = (text) => {
      const p = createNode('p');
      p.appendChild(createTextNode(text));
      body.appendChild(p);
      return p;
    };
    const setText = (node, text) => {
      node.nodeValue = text;
      node.data = text;
      if ('textContent' in node) node.textContent = text;
    };

    makeP('房间 9 号有钥匙。');
    const dialP = makeP('转盘密码 1');
    const dialText = dialP.firstChild;

    startReader({ now: () => now, batchIntervalMs: 5000 });
    const batchTimer = intervals.find((t) => t.ms === 5000);
    assert.ok(batchTimer, '应注册 5000ms 批处理定时器');

    batchTimer.fn();

    now += 100;
    setText(dialText, '转盘密码 2');
    batchTimer.fn();

    now += 100;
    setText(dialText, '转盘密码 3');
    batchTimer.fn();

    now += 100;
    setText(dialText, '转盘密码 9');
    batchTimer.fn();

    dialP.firstChild.nodeValue = '';

    now += 6000;
    batchTimer.fn();

    const sentTexts = sent.map((m) => String(m && m.payload && m.payload.text));
    assert.ok(sentTexts.length > 0, '应发生稳定补发');
    assert.ok(
      sentTexts.some((t) => t.includes('转盘密码 9')),
      `补发应为被跟踪项自己的句子，实际：${JSON.stringify(sentTexts)}`
    );
    assert.ok(
      !sentTexts.some((t) => t === '房间 9 号有钥匙。'),
      `不得借用页上同数字的其他句子，实际：${JSON.stringify(sentTexts)}`
    );
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('仅调换行顺序（内容不变）不发送整页', async () => {
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  try {
    let now = 200000;
    const intervals = [];
    globalThis.setInterval = (fn, ms) => {
      const timer = { fn, ms, id: intervals.length + 1 };
      intervals.push(timer);
      return timer.id;
    };
    globalThis.clearInterval = () => {};

    const sent = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: (...args) => { sent.push(args[0]); },
        onMessage: { addListener: () => {} },
      },
    };

    const body = createNode('body');
    const doc = createDocStub(body);
    globalThis.document = doc;

    const makeP = (text) => {
      const p = createNode('p');
      p.appendChild(createTextNode(text));
      body.appendChild(p);
      return p;
    };

    const p1 = makeP('第一行线索。');
    const p2 = makeP('第二行线索。');
    const p3 = makeP('第三行线索。');

    startReader({ now: () => now, batchIntervalMs: 5000 });
    const batchTimer = intervals.find((t) => t.ms === 5000);
    assert.ok(batchTimer, '应注册 5000ms 批处理定时器');

    batchTimer.fn();
    assert.strictEqual(sent.length, 0, '初始 tick 不应发送');

    // 整页倒序
    body.firstChild = p3;
    p3.nextSibling = p2;
    p2.nextSibling = p1;
    p1.nextSibling = null;

    now += 100;
    batchTimer.fn();
    assert.strictEqual(sent.length, 0, '整页倒序不应发送');

    // 只交换其中两行（p1 和 p3）
    body.firstChild = p1;
    p1.nextSibling = p2;
    p2.nextSibling = p3;
    p3.nextSibling = null;

    now += 100;
    batchTimer.fn();
    assert.strictEqual(sent.length, 0, '仅交换两行不应发送');
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('调序并且多了一行新内容时只发送那行新内容', async () => {
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  try {
    let now = 300000;
    const intervals = [];
    globalThis.setInterval = (fn, ms) => {
      const timer = { fn, ms, id: intervals.length + 1 };
      intervals.push(timer);
      return timer.id;
    };
    globalThis.clearInterval = () => {};

    const sent = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: (...args) => { sent.push(args[0]); },
        onMessage: { addListener: () => {} },
      },
    };

    const body = createNode('body');
    const doc = createDocStub(body);
    globalThis.document = doc;

    const makeP = (text) => {
      const p = createNode('p');
      p.appendChild(createTextNode(text));
      body.appendChild(p);
      return p;
    };

    const p1 = makeP('第一行线索。');
    const p2 = makeP('第二行线索。');
    const p3 = makeP('第三行线索。');

    startReader({ now: () => now, batchIntervalMs: 5000 });
    const batchTimer = intervals.find((t) => t.ms === 5000);
    assert.ok(batchTimer, '应注册 5000ms 批处理定时器');

    batchTimer.fn();
    assert.strictEqual(sent.length, 0, '初始 tick 不应发送');

    // 旧行齐全，仅调序并追加新行
    body.firstChild = p3;
    p3.nextSibling = p2;
    p2.nextSibling = p1;
    p1.nextSibling = null;
    const p4 = makeP('第四行新线索。');
    p1.nextSibling = p4;
    p4.nextSibling = null;

    now += 100;
    batchTimer.fn();

    assert.ok(sent.length > 0, '新增行应触发发送');
    const lastText = String(
      sent[sent.length - 1] &&
      sent[sent.length - 1].payload &&
      sent[sent.length - 1].payload.text
    );
    assert.ok(lastText.includes('第四行新线索'), `应包含新增行，实际：${lastText}`);
    assert.ok(!lastText.includes('第一行线索'), `不应重发旧行，实际：${lastText}`);
    assert.ok(!lastText.includes('第二行线索'), `不应重发旧行，实际：${lastText}`);
    assert.ok(!lastText.includes('第三行线索'), `不应重发旧行，实际：${lastText}`);
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('同模板含数字调换顺序且无新增行时不重发', async () => {
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  try {
    let now = 400000;
    const intervals = [];
    globalThis.setInterval = (fn, ms) => {
      const timer = { fn, ms, id: intervals.length + 1 };
      intervals.push(timer);
      return timer.id;
    };
    globalThis.clearInterval = () => {};

    const sent = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: (...args) => { sent.push(args[0]); },
        onMessage: { addListener: () => {} },
      },
    };

    const body = createNode('body');
    const doc = createDocStub(body);
    globalThis.document = doc;

    const makeP = (text) => {
      const p = createNode('p');
      p.appendChild(createTextNode(text));
      body.appendChild(p);
      return p;
    };

    const p1 = makeP('第1关 密码 38');
    const p2 = makeP('第2关 密码 52');
    const p3 = makeP('第3关 密码 17');

    startReader({ now: () => now, batchIntervalMs: 5000 });
    const batchTimer = intervals.find((t) => t.ms === 5000);
    assert.ok(batchTimer, '应注册 5000ms 批处理定时器');

    batchTimer.fn();
    assert.strictEqual(sent.length, 0, '初始 tick 不应发送');

    // 整页倒序，数字顺序改变但模板相同
    body.firstChild = p3;
    p3.nextSibling = p2;
    p2.nextSibling = p1;
    p1.nextSibling = null;

    now += 100;
    batchTimer.fn();
    assert.strictEqual(sent.length, 0, '仅调序不应发送');

    // 再交换两行
    body.firstChild = p2;
    p2.nextSibling = p3;
    p3.nextSibling = p1;
    p1.nextSibling = null;

    now += 100;
    batchTimer.fn();
    assert.strictEqual(sent.length, 0, '再次调序不应发送');
  } finally {
    stopReader();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});