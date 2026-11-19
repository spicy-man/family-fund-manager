# Handoff: 架构收敛进度与后续待办

> **基线状态**：截至 `v4.7.7`（2026-11-19），已完成 Tier 0 + Tier 1 历史包袱清理以及 Tier 2 **Batch 1 – Batch 3** 架构收敛，并通过两轮双人独立审查闭环（见 `docs/technical/reviews/DUAL_REVIEW_2026-11-19.md`）、全量 `npm test`、`npm run demo:build` 与 `git diff --check`。

---

## 一、已完成项与承重边界（后续会话请勿误触）

### 已在 v4.7.5（Tier 0 + Tier 1）移除
- 废除的 `benchmarkClosePolicy`（`same_day`）前端控制器、轮询、死 CSS 与 `routes/settings.js` 无意义写盘（保留非法值 400 拦截及 `lib/storage.js` 旧库迁移清洗）。
- 仅在 v3.19.0 存活过的 10 个静态只读 `demo-data/*.json` 构建与 `api.js` / `demo-mode.js` 中的 `staticDemo` 路由分支（保留本地 `/demo` 与 GitHub Pages `seed.json` 交互沙盒）。
- 脱离真实代码的 v1.0 玩具模拟测试 `test/test-model.js`、对数坐标残留 `activeScaleType` / `.scale-slice-btn`、永久隐藏的 `.header-logo` / `.version-badge`、透明 `.sidebar-nav::before` 几何读取、`lib/yahoo.js` 过时封装、16 个未用 CSS 变量、6 个死 `_` 事件载荷字段及多个零调用方模块导出。
- `docs/technical/MULTI_LEDGER.md` 与 `test/test-combined-overview.js` 中的真实成员信息脱敏；打包脚本 URL/排除规则与 `.gitattributes` 修正。

### 已在 v4.7.7（Batch 1 – Batch 3）完成
- **Batch 1（零风险降噪与物理隔离）**：
  - 冻结的 `settlePerformanceV1` / `settlePerformanceV2` 拆至 `lib/legacy-performance-settlement.js`；`lib/performance-settlement.js` 保留现行 V3 算法、版本对比表与纯只读 `estimateLotsPerformanceFee`。
  - `lib/calculator.js` 入口浅克隆 `db.events` 消除调用方原地污染，并用 `estimateLotsPerformanceFee` 替代 `'estimate-lp'` / `'estimate-gp'` 虚拟成员 hack。
  - `server.js` 的 `--launcher-child` IPC 守护与信号优雅退出逻辑抽至 `lib/process-lifecycle.js`；`lib/http-json.js` 补齐代理环境变量传参设计说明。
- **Batch 2（前端 DOM、图表与工具收口，含 T2-2 / 部分 T2-4）**：
  - `public/index.html` 清理尾部夹在 `<script>` 间的 4 个浮层、`#ticker-ath-container` 直接落位 `.layout-right`、`.metric-label` 静态短标题与 `#fund-total-shares` 初始文案修正、侧边栏与主栏 `#trends-section` / `#members-section` 改为真实视觉顺序；清理对应 CSS `order` 倒置与 `.ticker-ath-bar` 冲突规则（保持 `position: relative` 以确保减弱动效模式下 Tooltip 包含块有效），移除 `app.js` 启动 DOM 补丁与 GP 双重过滤。
  - 3 个 Chart.js 自定义插件抽至 `public/js/chart-plugins.js`；`chart-renderer.js` 统一 `getChartThemePalette` / `applyChartTheme` 并移除 `pointRadius: 0` 逐点颜色计算，消除 `app.js` 渲染后的二次 `chart.update()`。
  - `date-time.js` 集中美东/北京双时区 helper，`ui-utils.js` 统一 `formatRatePercent`，`api.js` 补齐多账本接口，`ledger-renderer.js` / `ledger-actions-controller.js` 改为 `<tr data-event-id>` 与 `flushPending()` 防重入锁（`hasPending` 覆盖 `flushingPromise`）；`scripts/build-static-demo.js` 补齐 HTML 替换锚点断言。
- **Batch 3（后端职责、读写边界与重复逻辑合并，含 T2-3）**：
  - `server.js` 拆出 `ensureLedgerMigrated()`（启动与副账本加载显式执行）、`readCoreDb()`、`buildReplayInput()` 与带 `StorageError` 包装的 `readCnhRate()`，移除 `readBaseDb` 补丁（`routes/members.js` 与 `routes/settings.js` 保留直调兜底兼容）。
  - `routes/backup.js` 300 行解析校验全部下沉至 `lib/backup-import.js`（`prepareBackupRestore`，合并重复遍历并统一中文错误文案）。
  - `lib/transaction-service.js` 提取纯函数 `toEditableCandidateEvent` / `finalizePersistedEvent` 替代全额退出编辑时的原地 delete/覆写体操。
  - 新增共享模块 `lib/date-utils.js`（双时区、`previousWeekday`、`isValidDate`、`getLatestValuationDate`）、`lib/db-fields.js`（缓存字段剥离）、`lib/ledger-id.js`（统一 `ledger-2..999` 判定）；`lib/custom-benchmark.js` 导出 `TICKER_PATTERN` 统一标的正规校验；`lib/performance-fee-policy.js` 新增 `getEventGpMemberId`；`routes/members.js` 合并单条/批量更新逻辑并兼容 `newId ?? memberId`（前端已切 `newId`）。

### 绝对不能移除的承重设计与历史兼容层
- **核心财务不变量**：40 位 `Decimal.js` 全量事件溯源重放（有意不做持久化 checkpoint）、`remainingPrincipal` 与批次 `basis` 解耦、四条 BPL 治理规则（GP 自我结算、出金先 LP 后 Carry、V3 周期重置且 HWM 单调不降且不加 ULP 容差、逐批独立核算）、写前沙箱验证与 HMAC 预览令牌。
- **冻结历史重放**：`lib/legacy-performance-settlement.js`（V1/V2 冻结算法）、`lib/performance-settlement.js`（V3 与分发入口）、`lib/settlement-ledger.js` 快照匹配迁移、`disposalVersion: 1` 旧处置语义（`NET_DISPOSAL_VERSION = 2`）、`retainLegacyFullTransfer`、以及 `lib/storage.js` / `lib/backup-import.js` 中的 `db.json` 懒冷迁移。
- **数据安全与多账本**：`.fund-manager.lock/` 单写锁、`pending_backup` 先提交后滚动淘汰、`.snapshot-transaction.json` 事务恢复、`.settlements-initialized` 标记、`data/ledger.json`（多账本元数据与原子发布标记）、`scripts/launch.js` 分离会话启动器、`lib/local-request-policy.js` 与严格本地 CSP。

---

## 二、后续待办清单（未推进部分）

### Batch 4：多账本架构收敛（含 T2-1、4.2 #1、4.3 #1）
1. **`lib/storage.js` 原生分离共享层与账本私有层**：
   - 将共享存储（`config.json` 与行情/汇率缓存，内置 `sharedRevision` 自增）与账本私有存储（`db.json`、`settlements.json`）在 `lib/storage.js` 原生组合，彻底移除 `lib/ledgers.js` 对 `defaultStorage` 7 个写方法的猴子补丁与 12 个共享方法覆写。
2. **拆分副账本纯 API Router / `LedgerContext`（T2-1）**：
   - 将 `server.js` 中的 `createLedgerApplication` 拆分为“仅挂载一次的顶层 HTTP 壳（安全头、CSP、`localRequestPolicy`、静态资源、vendor、`/demo`）”与“纯账本 API 路由器”，消除副账本实例化完整 Express App、重复校验与双重包装 `res.json`。
3. **抽取 `server.js` 与 `demo/browser/sandbox.js` 共享纯函数层**：
   - 抽取与运行时（Node 磁盘 vs 浏览器 SessionStorage）无关的共享字段校验、账本名称/ID 校验与 `coreDb + settlements + caches` 组装逻辑，消除两边重复胶水代码。
   - 验证重点：`test/test-ledgers.js`、`test/test-combined-overview.js`、`test/test-demo-sandbox.js`、`test/test-static-demo.js`、`test/test-security-policy.js`。

### 前端剩余结构清理（T2-4 剩余项 / 4.2 #4 / 4.3 #3）
- **CSS 叠层收敛**：`public/css/privacy-semantics.css` 覆盖并推翻 `theme.css`、`dashboard.css`、`base-navigation.css`、`ticker.css` 的大段视觉规则（含同文件两次覆盖 `.badge-deposit`/`.badge-withdraw`）；另 `dashboard.css` 两段 `.metric-icon`、`ledger.css` 与 `controls.css` 重复 `.btn-delete`、`responsive-members.css` 三代 `.member-edit-item` 可按需回并基础模块（需配合浏览器实机核验视觉一致性）。
- **`app.js` DOM 中转瘦身**：各弹窗子 Controller 在自身 `init()` 按 ID 获取私有 DOM；将 `renderDashboard()` 弹窗核对明细渲染移入 `public/js/metric-details.js`。
- **自定义基准缓存对称化（4.2 #4）**：将 `lib/custom-benchmark.js` 中 Slot 0 顶层摊平 / Slot 1 嵌套 `.secondary` 的读取路径归一化为对称结构。

### T2-5：文档同步与长期未决项
- **文档与现实同步**：
  - 更新 `docs/technical/ARCHITECTURE.md`（当前仍停留在 v3.16.1 快照，缺失多账本、`transaction-service.js`、`local-request-policy.js`、`backup-import.js`、浏览器沙盒、试算器、成员报表、Batch 1–3 模块拆分）。
  - 整理/压缩 `docs/technical/reviews/` 中 2026-10-16 的重叠会话归档，并清理历史归档中硬编码本地盘符的 `file:///` 链接。
  - 修正 `README.md` 自相矛盾（第 73 行仍写沙盒自定义基准仅支持 `AAPL, GOOGL, VGT`，与第 51 行 20 标的矛盾；数据表漏列 `market-history.json` 与 `ledger-N/`）及 `数据迁移说明.md`（补全 `market-history.json`、`.settlements-initialized`、多账本目录与 `start.command`）。
- **既有未决技术债 / 审查项**（来自 `docs/project/TASKS.md` 与 `docs/technical/CODE_REVIEW.md`）：
  - `TASK-008`（跨设备/局域网只读鉴权边界）、`TASK-011`、`TASK-016`–`018`（`server.js` / `storage.js` / `calculator.js` 进一步拆分）。
  - `#10`（本地 `/demo` 每次请求完整重放，可评估缓存）、`#11`（美股假日可能反复探测行情）。
  - `lib/http-json.js` 的 `curl -L` 补充 `--proto =https --proto-redir =https`；`routes/tickers.js` 为 `tickers` 数组增加上限校验。

---

## 三、待用户决断项

- **Git 历史重写决策**：工作区已清除真实成员姓名与编号，但远端历史提交 `1783970`–`31c32ef` 及已打标的 `v4.7.2`–`v4.7.4`（含对应 GitHub Release ZIP 附件）仍保留原文本。若需彻底擦除历史，须在独立授权下执行历史重写并强推相关分支/标签及替换旧 Release 附件。
