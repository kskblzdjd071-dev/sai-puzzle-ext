// 网页游戏解谜整理插件 - 测试驱动执行器
// 负责在零额外依赖的 Node 环境下运行烟雾测试
import { tests } from './smoke.test.js';

async function run() {
  console.log(`\n准备执行冒烟测试集，共 ${tests.length} 个用例...\n`);
  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✔ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✖ [FAIL] ${name}`);
      console.error(err);
      failed++;
    }
  }

  console.log(`\n测试执行完毕: ${passed} 成功, ${failed} 失败\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();
