# 2026-11-19 v4.7.7 架构收敛（Batch 1–3）双人独立审查记录

> 审查日期：2026-11-19  
> 对应版本：`v4.7.7`  
> 审查范围：Batch 1–3 全部工作区改动（46 个修改文件与 6 个新增模块：`lib/date-utils.js`、`lib/db-fields.js`、`lib/ledger-id.js`、`lib/legacy-performance-settlement.js`、`lib/process-lifecycle.js`、`public/js/chart-plugins.js`）  
> 审查方式：两名未预读历史台账的独立审查者（Reviewer A / Reviewer B）各自完整只读审查，经修复闭环后基于同一份最终代码重新独立复审。

---

## 一、第一轮审查有效发现与修复闭环

第一轮共确认 4 项有效发现（两方无分歧）：

| 编号 | 级别 | 来源 | 问题摘要 | 修复措施 |
| :--- | :--- | :--- | :--- | :--- |
| R1 | 中 | 双人共识 | `public/css/ticker.css` 将 `.ticker-ath-bar` 设为 `position: static`，覆盖 `.glass-panel { position: relative }`；在 `prefers-reduced-motion: reduce` 禁用入场动画后，`.ticker-external-tooltip` 与 `.premium-border::before` 丧失定位包含块并错位逃逸；另 `responsive-members.css` 存在被 `ticker.css` 覆盖的无效 `.ticker-ath-bar` 规则 | 将 `public/css/ticker.css` 中 `.ticker-ath-bar` 改为 `position: relative`；移除 `public/css/responsive-members.css` 中被覆盖的无效规则 |
| R2 | 中 | 双人共识 | `routes/settings.js` 与 `routes/members.js` 缺少直调依赖兜底（仅传 `readDb` 时会抛 `TypeError`）；`server.js` 注入的 `readCnhRate` 未像其他存储读方法一样包装 `StorageError` | 在 `routes/settings.js` 补 `readCnhRate = () => deps.readDb?.().cnhRate`；在 `routes/members.js` 补 `readCoreDb = deps.readBaseDb ?? deps.readDb`；在 `server.js` 新增 `readCnhRate()` 并将异常统一包装为 `StorageError` |
| R3 | 低 | Reviewer B | 试算与结算预览去掉 `hasPending()` 守卫后，无待删除记录时也无条件 `await flushPending()` 让出微任务，导致按钮禁用与校验推迟到微任务之后 | 将 `ledger-actions-controller.js` 的 `hasPending` 升级为 `() => pendingDeletes.size > 0 || Boolean(flushingPromise)`；在 `disposal-trial-controller.js` 与 `settlement-controller.js` 恢复 `hasPending()` 守卫并保留 `flushPending()` 内部防重入锁 |
| R4 | 低 | Reviewer A | `lib/http-json.js` 新增顶部注释称通过 `curl --config -`（stdin）传递代理凭据，与实际通过子进程环境变量 `childEnv` 传递不符 | 更正文件头注释为通过子进程环境变量（`childEnv`）传递代理配置，避免暴露在命令行参数 `argv` 中 |

---

## 二、重点核查无回归区域

- **核心财务与历史回放**：冻结的 V1/V2 结算算法逐字无损迁入 `lib/legacy-performance-settlement.js`；纯只读 `estimateLotsPerformanceFee` 与 V3 结算等价；`calculateStateFromDb` 入口浅克隆 `db.events` 无嵌套变异；`toEditableCandidateEvent` / `finalizePersistedEvent` 完整保留全额退出及 `retainLegacyFullTransfer` 语义。
- **读写边界与启动迁移**：`ensureLedgerMigrated()` 在服务启动与副账本加载时显式执行且在 `readCoreDb()` 具备幂等兜底，写入失败正确重置缓存与校验标记；浏览器沙盒 `demo/browser/sandbox.js` 保持兼容。
- **安全边界与备份恢复**：`prepareBackupRestore` 保留 10MB 共享解压预算、CRC32 校验、事件总数上限、原型链键防护及遗留内嵌结算对象引用共享；统一后的 `TICKER_PATTERN`（含 `=`）在 Yahoo 请求经 `encodeURIComponent` 编码、前端经 `escapeHtml` 转义；本地 CSP 与静态沙盒锚点断言正常。

---

## 三、第二轮复审与最终验证

- **第二轮双人复审**：Reviewer A 与 Reviewer B 基于最终工作区代码独立复审全部 4 项修复与全局回归边界，两方均确认修复完整无副作用，**本轮未发现未解决问题**。
- **最终发布前验证**（全部隔离环境执行，未触碰正式数据目录）：
  - `npm test`：全量隔离回归测试全部通过（含版本号一致性、发布说明提取、39 个前端脚本语法、CSS 入口、CSP 安全策略、历史结算/处置重放、备份恢复与多账本沙盒）。
  - `node scripts/release-notes.js v4.7.7`：通过。
  - `npm run demo:build`：静态隔离沙盒构建通过。
  - `git diff --check`：无空白与格式问题。
