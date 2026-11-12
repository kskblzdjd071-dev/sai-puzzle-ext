// 职责：经典内容脚本入口，通过动态 import 加载 ES 模块版 reader
// 作者：Banana

(function () {
  if (globalThis.__SAI_READER_LOADER__) {
    return;
  }
  globalThis.__SAI_READER_LOADER__ = true;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    import(chrome.runtime.getURL('content/reader.js')).catch((err) => {
      console.warn('reader 模块加载失败：', (err && err.message) || err);
    });
  }
})();
