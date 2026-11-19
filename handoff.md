# Handoff: Tier 2 架构收敛与后续待办

> **基线状态**：基于 `v4.7.4`（`31c32ef`）完成 Tier 0 + Tier 1 历史包袱清理与两轮双人独立审查闭环；`npm test`（57 个隔离测试脚本）、`git diff --check` 与隔离沙盒构建均通过。

---

## 一、已清理项与承重边界（后续会话请勿误触）

### 已在 Tier 0 + Tier 1 移除
- 废除的 `benchmarkClosePolicy`（`same_day`）前端控制器、轮询、死 CSS 与 `routes/settings.js` 无意义写盘（保留非法值 400 拦截及 `lib/storage.js` 旧库迁移清洗）。
- 仅在 v3.19.0 存活过的 10 个静态只读 `demo-data/*.json` 构建与 `api.js` / `demo-mode.js` 中的 `staticDemo` 路由分支（保留本地 `/demo` 与 GitHub Pages `seed.json` 交互沙盒）。
- 脱离真实代码的 v1.0 玩具模拟测试 `test/test-model.js`、对数坐标残留 `activeScaleType` / `.scale-slice-btn`、永久隐藏的 `.header-logo` / `.version-badge`、透明 `.sidebar-nav::before` 几何读取、`lib/yahoo.js` 过时封装（`findCloseForPolicy` / `findPreviousClose` / `getTickerHistoryStartSec`）、16 个未用 CSS 变量、6 个死 `_` 事件载荷字段及多个零调用方模块导出。
- `docs/technical/MULTI_LEDGER.md` 与 `test/test-combined-overview.js` 中的真实成员信息已脱敏；`一键打包.bat` / `一键打包.command` 仓库 URL 与排除规则已修正；新增 `.gitattributes` 管理 `.bat` 的 `CRLF`。

### 绝对不能移除的承重设计与历史兼容层
- **核心财务不变量**：40 位 `Decimal.js` 全量事件溯源重放（有意不做持久化 checkpoint）、`remainingPrincipal` 与批次 `basis` 解耦、四条 BPL 治理规则（GP 自我结算、出金先 LP 后 Carry、V3 周期重置且 HWM 单调不降且不加 ULP 容差、逐批独立核算）、写前沙箱验证与 HMAC 预览令牌。
- **冻结历史重放**：`lib/performance-settlement.js` 的 V1/V2/V3 冻结算法与 `lib/settlement-ledger.js` 快照匹配迁移、`disposalVersion: 1` 旧处置语义（`NET_DISPOSAL_VERSION = 2`）、`retainLegacyFullTransfer`、以及 `lib/storage.js` / `routes/backup.js` 中的 `db.json` 懒冷迁移。
- **数据安全与多账本**：`.fund-manager.lock/` 单写锁、`pending_backup` 先提交后滚动淘汰、`.snapshot-transaction.json` 事务恢复、`.settlements-initialized` 标记、`data/ledger.json`（多账本元数据与原子发布标记）、`scripts/launch.js` 分离会话启动器、`lib/local-request-policy.js` 与严格本地 CSP。

---

## 二、Tier 2 架构收敛任务清单（待下一轮推进）

### T2-1：拆分副账本 API 子路由器（高收益、低风险）
- **位置**：`server.js`（`createLedgerApplication` 第 33–114、455–458 行）、`lib/ledgers.js`（`registerLedgerRoutes` 第 60、138–152 行）
- **现状问题**：`lib/ledgers.js` 在默认 App 已执行 CSP、`localRequestPolicy`、`normalizeApiErrorResponses`、`express.json` 与 `express.static` 之后，仅将 `/api/*`（排除 `/api/demo/*`）转发到 `instance(id).app`。但 `createLedgerApplication` 为每个副账本都挂载了完整的顶层中间件、静态/字体路由、vendor 路由与 `/demo` 路由，导致副账本请求重复执行校验并双重包装 `res.json`。
- **改造方向**：将 `createLedgerApplication` 拆分为“仅挂载一次的顶层 HTTP 壳（安全头、静态资源、vendor、`/demo`）”与“纯账本 API 路由器”，副账本仅实例化纯 API 路由器与独立状态缓存。

### T2-2：消除启动时 DOM 猴补丁与 HTML 排版倒置
- **位置**：`public/index.html`（174、229–266、426、1512–1594 行）、`public/js/app.js`（105–107、242–244 行）、`public/css/ticker.css`、`public/css/base-navigation.css`、`public/css/members-charts.css`、`public/css/responsive-members.css`
- **现状问题**：
  1. `#ticker-ath-container` 在 `index.html` 置于 `.app-container` 顶部，运行时由 `app.js` 搬移进 `.layout-right`，导致 `ticker.css` 存在三段冲突的 `position`（`fixed` → `relative` → `static`）。
  2. `.metric-label` 在 HTML 中保留旧双语长标题，运行时由 `app.js` 覆写为短标题。
  3. `#member-statement-modal`、`#ledger-menu`、`#combined-overview-modal`、`#manage-ledgers-modal` 四个浮层插在 `<script>` 标签序列中间（1512–1594 行）。
  4. `#members-section` 与 `#trends-section` 依靠 `base-navigation.css` 和 `members-charts.css` 中的 `order` 视觉对调，而非直接按真实顺序排列 DOM。
- **改造方向**：直接调整 `index.html` 的 DOM 顺序与静态文案，移出 `app.js` 对应运行时补丁，并清理 `ticker.css` 中遗留的 `position: fixed` 样式；完成后重点核验桌面/窄屏布局及 `test/test-css-entry.js`、`test/test-security-policy.js`、`test/test-frontend-syntax.js`。

### T2-3：合并后端重复逻辑与校验口径漂移
- **`previousWeekday` 重复**：`lib/market-history.js`（112–118 行，已导出但生产未用）与 `routes/tickers.js`（47–53 行，局部重复定义）合并为一处。
- **标的代码正则不一致**：`lib/custom-benchmark.js:1`（`TICKER_PATTERN`）允许 `=`（支持 `GC=F` 等），而 `routes/tickers.js:216` 与 `routes/backup.js:312` 复制了不含 `=` 的版本；统一导出并复用（需确认自选标的面板是否允许 `=`）。
- **副账本 ID 正则不一致**：`lib/ledgers.js:29` 限制 `ledger-2..999`，而 `lib/storage.js:341`、`lib/stored-member-ids.js:6` 与 `scripts/migrate-member-identifiers.js:14` 使用 `/^ledger-[1-9][0-9]*$/`，统一由共享 helper 判定。
- **缓存字段剥离收口**：`lib/storage.js` 的 `withoutIndexCache` 剥离 `indexCache`、`customBenchmarkCache`、`marketHistory`，而 `writeDb`、`writeSnapshot` 与 `routes/backup.js` 各自额外手写剥离 `cnhRate`；提取统一剥离 helper。
- **路由与校验收敛**：评估将 `routes/members.js` 单条更新 `PUT /api/members/:id` 与批量更新 `PUT /api/members` 的公共逻辑抽取为共享 helper，并简化 `routes/backup.js` 与 `lib/backup-import.js` 之间的重复事件校验。

### T2-4：前端重复工具、图表双渲染与 `privacy-semantics.css` 收敛
- **工具函数去重**：收敛 4 份 `escapeHtml`（`ui-utils.js`、`combined-overview.js`、`disposal-trial-controller.js`、`chart-renderer.js`）、3 份深色主题判断（`ui-utils.js`、`theme-manager.js`、`chart-renderer.js`）、3 份费率百分比格式化，以及统一 `date-time.js` 与 `chart-renderer.js` 的美东时间解析（并核查 `member-statement-controller.js` 采用 `Asia/Shanghai` 口径是否是有意差异）。
- **图表冗余重绘**：`app.js:700` 在 `FundChartRenderer.render()` 之后紧接调用 `updateChartsColors()` 触发二次 `.update()`；`chart-renderer.js` 的 `updateTheme` 仍为 `pointRadius: 0` 的主线逐点计算 `pointBackgroundColor`（操作标记点已迁至 `operationTrackPlugin`）。
- **API 客户端收口**：`ledger-switcher.js` 与 `combined-overview.js` 直接调用全局 `requestApi`/`jsonRequest`，可纳入 `Api` 对象统一管理。
- **CSS 叠层收敛**：`public/css/privacy-semantics.css` 覆盖并推翻了 `theme.css`、`dashboard.css`、`base-navigation.css`、`ticker.css` 的大段视觉规则（包含禁用 `.glass-panel.premium-border::before`、清除梯度与 `backdrop-filter`，以及同文件内先后两次覆盖 `.badge-deposit`/`.badge-withdraw`）；另 `dashboard.css` 存在两段 `.metric-icon`、`ledger.css` 与 `controls.css` 重复定义 `.btn-delete`、`responsive-members.css` 叠有三代 `.member-edit-item`。可将最终生效规则回并到各自基础 CSS 模块。

### T2-5：文档同步与长期未决项
- **文档与现实同步**：
  - 更新 `docs/technical/ARCHITECTURE.md`（当前仍停留在 v3.16.1 快照，缺失多账本、`transaction-service.js`、`local-request-policy.js`、`backup-import.js`、浏览器沙盒、试算器、成员报表）。
  - 更新 `docs/technical/CODE_REVIEW.md`（当前停留在 2026-10-05，缺 2026-10-16 审查记录）并整理/压缩 `docs/technical/reviews/` 中的重叠会话归档（清理其中硬编码本地盘符的 `file:///` 链接）。
  - 修正 `README.md` 自相矛盾（第 73 行仍写沙盒自定义基准仅支持 `AAPL, GOOGL, VGT`，与第 51 行 20 标的矛盾；数据表漏列 `market-history.json` 与 `ledger-N/`）及 `数据迁移说明.md`（补全 `market-history.json`、`.settlements-initialized`、多账本目录与 `start.command`）。
- **既有未决技术债 / 审查项**（来自 `docs/project/TASKS.md` 与 `docs/technical/CODE_REVIEW.md`）：
  - `TASK-008`（跨设备/局域网只读鉴权边界）、`TASK-011`、`TASK-016`–`018`（`server.js` / `storage.js` / `calculator.js` 职责拆分）。
  - `#10`（本地 `/demo` 每次请求完整重放，可评估缓存）、`#11`（美股假日可能反复探测行情）。
  - `lib/http-json.js` 的 `curl -L` 补充 `--proto =https --proto-redir =https`；`routes/tickers.js` 为 `tickers` 数组增加上限校验。

---

## 三、待用户决断项（如未在本轮发版前处理）

- **Git 历史重写决策**：当前工作区已清除真实成员姓名与编号，但远端历史提交 `1783970`–`31c32ef` 及已打标的 `v4.7.2`–`v4.7.4`（含对应 GitHub Release ZIP 附件）仍保留原文本。若需彻底擦除历史，须在独立授权下对最近 6 个提交执行 `git rebase` / `git-filter-repo` 并强推 `main`、重推 `v4.7.2`–`v4.7.4` Tag 及替换旧 Release 附件。

---

## 四、新工程师接手认知成本评估与架构简化方案（供 Neon 接手）

> 本节基于双人独立盲审（不预读历史台账）汇总核实，站在“能力强但完全无项目背景的工程师”视角，梳理全库命名歧义、抽象过度、职责混杂与高上下文隐式契约，并按低风险高收益梯度给出简化路线。
>
> **执行红线**：推进以下任何简化时，必须严守第一节“绝对不能移除的承重设计与历史兼容层”，确保历史账本重放、`decimal.js` 精度、安全策略与测试集 100% 零回归。

### 4.1 命名混乱与概念歧义（同名不同义、一物多名、语义翻转）

1. **`readDb()` 的三重语义与 `readBaseDb` 补丁**
   - **位置**：`lib/storage.js:335-429`、`server.js:144-222`、`server.js:465-467`、`routes/members.js:60-61, 120`、`routes/backup.js:26-41`、`demo/browser/sandbox.js:44-50, 105`
   - **认知痛点**：
     - `storage.readDb()` 返回纯粹的 `db.json`；
     - `server.js` 的同名 `readDb()` 却变成“大杂烩聚合器”：混入 `customBenchmarkCache`、`indexCache`、`marketHistory`、`cnhRate`，首次调用还会触发结算迁移并调用 `mergeSettlementLedger` 把 `settlements.json` 记录拼进 `db.events`；
     - `demo/browser/sandbox.js` 的 `readDb()` 甚至把 `state.config` 也展开混了进去；
     - 导致 `writeDb()`（`server.js:206-215`）和 `/api/backup/export`（`routes/backup.js:26-41`）每次都要反向 filter 掉结算事件、delete 掉缓存字段；而 `routes/members.js:60-61` 出现 `const migratedDb = readDb(); const db = deps.readBaseDb?.() ?? migratedDb;` 这样先调 `readDb` 触发迁移副作用、再用 `readBaseDb` 取未合并数据的绕圈代码。
   - **简化方案**：
     - 将 `server.js` 中的 `readDb()` 拆为职责清晰的两个函数：`readCoreDb()`（只读纯 `db.json`）与 `buildReplayInput()`（拼装 `coreDb + settlements + caches` 专供 `calculateStateFromDb` 使用）；
     - 路由层读写只操作 `readCoreDb()` 与 `readSettlements()`，彻底消除 `readBaseDb` 补丁及 `writeDb`/`backup` 中的反向剥离代码。

2. **GP 身份的 4 种表达方式**
   - **位置**：`lib/storage.js:34-39, 407-415`、`lib/performance-fee-policy.js:7-11, 38-42`、`lib/member-identifiers.js:7`、`routes/members.js:18-22, 134-152`、`public/js/app.js:479, 509-515`
   - **认知痛点**：
     - 业务规则其实只有一条：**每个账本最多指定一位主 GP，所有成员默认都是 LP**（`storage.js:407-410` 每次读取都强制令 `member.roles = { lp: true, gp: db.performanceFee.gpMemberId === member.id }`）。
     - 但代码中同时存在 4 种表达：① 配置级 `db.performanceFee.gpMemberId`；② 事件快照级 `event.performanceFee.gpMember` / `event.gpMember`（不带 `Id`）；③ 成员持久化 `member.roles.gp`；④ 接口动态字段 `member.primaryGp`。
     - 前端 `app.js:509-515` 甚至先 `.filter(m => m.roles?.gp === true)` 再 `.filter(m => m.primaryGp)`。
   - **简化方案**：
     - 明确唯一事实来源为 `db.performanceFee.gpMemberId`；
     - 在 `lib/performance-fee-policy.js` 提供统一 helper `getEventGpMemberId(event)` 屏蔽配置与事件快照的字段名差异；
     - 前端统一只认 `primaryGp`，删除 `app.js:509-515` 的双重过滤。

3. **`event.amount` 在全额退出时的原地覆写与逆向还原手术**
   - **位置**：`lib/transaction-service.js:178-183, 285-290, 321-349, 493-515`、`lib/calculator.js:293-318, 386-413`、`public/js/ledger-actions-controller.js:155-161, 177-179`
   - **认知痛点**：
     - 出金/转让在部分退出（`disposalVersion: 2`）时 `event.amount` 是实收净额；但在全额退出（`fullExit: true`）输入时是费前毛额，重放后 `transaction-service.js:178-183` 会把原 `amount` 挪到 `requestedGrossAmount`，再将扣费后的 `_actualAmount` **覆写回 `event.amount`**。
     - 当编辑该流水时（`transaction-service.js:321-349`），必须在 200 行的 `updateEvent` 开头原地 `delete event.fullExit`、把 `requestedGrossAmount` 倒回 `event.amount`、按比例缩放 `cnhAmount`，重放验证完再在 L507-511 覆写回去。
   - **简化方案**：
     - 提取纯函数 `toEditableCandidateEvent(existingEvent, patch)` 与 `finalizePersistedEvent(candidate, computedEvent)`，用不可变候选对象替代 `updateEvent` 中原地 delete / 覆写 / 回滚的状态体操。

4. **成员编号修改接口中的 `{ id, memberId, newId }` 语义冲突**
   - **位置**：`routes/members.js:55-93`、`public/js/member-editor-controller.js:243-266`
   - **认知痛点**：前端内部状态用 `{ id, name, newId }`，发给 `PUT /api/members` 时却映射为 `{ id, name, memberId: change.newId }`——同一载荷里用 `id` 表示旧主键、用 `memberId` 表示新主键。
   - **简化方案**：`PUT /api/members` 支持读取 `change.newId ?? change.memberId`，前端统一传 `newId`。

5. **DOM ID `#fund-total-shares` 与实际渲染内容错位**
   - **位置**：`public/index.html:230-233`、`public/js/app.js:85, 595-596`
   - **认知痛点**：`index.html:232` 默认写着 `<div class="metric-sub" id="fund-total-shares">总份额: 0.0000 份</div>`，但 `app.js:595` 实际渲染进去的是 `≈ ¥xx万 CNH收益（含汇率）`，与“总份额”完全无关（另见 T2-2 的 `.metric-label` 下标覆写问题）。
   - **简化方案**：与 T2-2 一并修正静态占位文案与变量注释（如需改 ID 需同步检查测试选择器）。

6. **成员汇总字段命名不对称**
   - **位置**：`lib/calculator.js:574-580` vs `621-636`
   - **认知痛点**：`summary` 中为 `totalDeposit / totalWithdraw` 与 `cnhTotalDeposit / cnhTotalWithdraw`，而 `computedMembers[k]` 中美元带 `Total`（`totalDeposit`），人民币却省掉了 `Total`（`cnhDeposit / cnhWithdraw`）。
   - **简化方案**：可在 `computedMembers[k]` 中补齐对称别名或在类型注释中标明（保留原字段名兼容前端与测试）。

---

### 4.2 抽象过度与绕弯子（猴子补丁、套娃实例、虚拟成员 Hack、入参污染）

1. **多账本对 `defaultStorage` 打猴子补丁 + 每个账本克隆完整 Express 实例（深化 T2-1）**
   - **位置**：`lib/ledgers.js:10-28, 54-66, 138-152`、`server.js:33-114, 287-295, 546`
   - **认知痛点**：
     - 除了 T2-1 提到的“每个子账本实例化完整 Express App 并通过 `req.url = '/api' + url` 伪转发”之外，`lib/ledgers.js:13-19` 还通过循环遍历 `defaultStorage` 的 7 个写方法原地打 **Monkey-Patch（猴子补丁）** 来维护闭包变量 `revision++`；
     - `lib/ledgers.js:20-27` 为子账本创建 `privateStore` 后，又把 12 个共享方法覆写回 `defaultStorage[key]`，并改写 `writeSnapshot` 强行丢弃传入的 `_config`。
   - **简化方案**：
     - 在 `lib/storage.js` 原生支持共享存储层（`config.json` 与行情缓存，内置 `sharedRevision` 自增）与账本私有存储层（`db.json`、`settlements.json`）的组合，彻底移除 `lib/ledgers.js:13-27` 的方法覆写与猴子补丁；
     - 结合 T2-1，将子账本收敛为轻量的 `LedgerContext`（或纯 API Router），全局仅保留一个顶层 Express `app`。

2. **`calculator.js` 为估算潜在业绩报酬构造虚拟成员 `'estimate-lp'` / `'estimate-gp'` 跑带副作用的结算函数**
   - **位置**：`lib/calculator.js:124-147, 503-511, 523-554`
   - **认知痛点**：
     - 在 `calculateStateFromDb` 末尾（L523-554），为了算每个成员截至当日的潜在业绩报酬（`memberPotentialFees`），先在重放过程中把 `Decimal` 转成字符串 `sharesExact` / `basisExact` 存进 `memberHighWaterHistory`，然后在 L533 又反序列化回 `Decimal`，构造假成员 `'estimate-lp'`、`'estimate-gp'` 和假事件 `'statement-estimate'`，去调用会执行扣减份额与重置批次副作用的 `settlePerformance` 再丢弃假成员。
     - 且每次后端做写前沙箱校验（`calculateLedgerState`）时，也会为所有成员白跑一遍这套试算。
   - **简化方案**：
     - 在 `lib/performance-settlement.js` 中提供约 15 行的纯只读函数 `estimateLotsPerformanceFee(lots, currentNAV, asOfDate, rates, output)`，直接遍历批次计算 `hurdleValue`、`excess`、`fee`；
     - 不再构造虚拟成员字典跑 `settlePerformance`，也可按需在仅做写操作校验时跳过报表潜在报酬试算。

3. **`calculateStateFromDb` 原地修改入参 `db.events`（挂载 15+ 个 `_` 私有属性）**
   - **位置**：`lib/calculator.js:245-248, 293-317, 323-325, 386-413, 416-427`；调用方防御性深拷贝：`routes/api.js:74`、`routes/settlements.js:45, 91`、`lib/transaction-service.js:94`、`lib/settlement-ledger.js:91`、`routes/demo.js:40, 44`
   - **认知痛点**：`calculateStateFromDb(db)` 直接在传入的 `db.events` 元素上原地挂载 `_navAtTx`、`_actualAmount`、`_grossAmount`、`_unpaidPerformanceFeeShares` 等 15 个临时属性，迫使所有调用方在调用前必须手写 `JSON.parse(JSON.stringify(db))`，一旦漏写就会污染内存缓存或落盘数据。
   - **简化方案**：在 `calculateStateFromDb` 入口对 `db.events` 做浅克隆（`db.events.map(e => ({ ...e }))`），保证计算器对传入的 `db.events` 数组及事件对象零原地变异（注意保留 `routes/api.js` / `transaction-service.js` 通过返回值或显式副本读取计算结果的能力）。

4. **自定义基准缓存（Slot 0 / Slot 1）的非对称嵌套结构**
   - **位置**：`lib/custom-benchmark.js:67-84`（`customEntryForSlot`, `mergeCustomEntryForSlot`）
   - **认知痛点**：`custom-benchmark-cache.json` 中每天的缓存对象，Slot 0 的属性直接摊平在顶层 `{ signature, components }`，而 Slot 1 却嵌在 `.secondary` 属性下（还带 `.primary` 兼容分支），每次读写都要调拆包/拼装函数。
   - **简化方案**：由于 `custom-benchmark-cache.json` 是可随时从 `market-history.json` 重算的派生缓存，可在读取时归一化为对称结构，简化读写分支。

5. **静态沙盒构建器的脆弱字符串 `.replace()` 注入**
   - **位置**：`scripts/build-static-demo.js:50-56`
   - **认知痛点**：直接用 `.replace('<head>', ...)` 和 `.replace('<script src="js/api.js"></script>', ...)` 注入沙盒脚本，一旦 `index.html` 调整了标签属性或缩进就会静默失效。
   - **简化方案**：在 `build-static-demo.js` 中对替换结果做锚点断言（若替换未命中则立即 `throw new Error(...)`）。

---

### 4.3 职责不清晰、巨石文件与重复造轮子

1. **`server.js` 与 `demo/browser/sandbox.js` 维护两套重复的后端读写组装与多账本管理代码**
   - **位置**：`server.js:144-328` vs `demo/browser/sandbox.js:44-153`、`lib/ledgers.js:29-137`
   - **认知痛点**：为了让静态沙盒在浏览器里运行，`sandbox.js` 把 `server.js` 的 `readDb`、`writeDb`、`normalizeRemark`、`normalizeMemberName`、`isValidDate` 以及 `lib/ledgers.js` 的多账本列表/创建/重命名校验又手写抄了一遍。
   - **简化方案**：提取与运行时（Node 磁盘 vs 浏览器 SessionStorage）无关的共享纯函数/服务层（如字段校验、账本名称与 ID 校验、`db + settlements + caches` 组装），消除两边百余行重复胶水代码。

2. **`routes/backup.js`（361 行）与 `lib/backup-import.js`（124 行）职责割裂，3 次重复遍历与中英文报错混杂（深化 T2-3）**
   - **位置**：`routes/backup.js:55-358`、`lib/backup-import.js:60-122`
   - **认知痛点**：
     - 路由处理器里内联了 300 行校验与迁移：L134-182 先循环校验一遍 `events`，L184 调 `normalizeImportedEvent` 又校验并 pick 一遍，L264-280 对 `backupSettlements.records` 做第三遍循环校验；
     - 且 L115, 122, 148, 155, 172 抛出英文报错（如 `'A transaction references a member that does not exist.'`），与相邻行的中文报错混杂。
   - **简化方案**：将备份解析、校验、历史结算拆分与重放验证全部下沉到 `lib/backup-import.js`，合并重复遍历并统一错误文案（需同步检查 `test/` 中是否有断言匹配英文报错），让 `routes/backup.js` 退化为薄路由层。

3. **前端 `app.js` 充当 90 个 DOM 节点的“中转总站” + `chart-renderer.js`（1059 行）巨石耦合**
   - **位置**：`public/js/app.js:74-233, 279-436, 562-659`、`public/js/chart-renderer.js:45-332, 399-517, 519-1058`
   - **认知痛点**：
     - `app.js` 在顶层集中 `getElementById` 抓取约 90 个 DOM 元素，再打包成巨型 `elements: { ... }` 传给 10 个子 Controller，同时自己还保留 `renderDashboard()`（L562-659）直接拼装资产/收益公式核对弹窗 DOM；
     - `chart-renderer.js` 单文件超千行，塞入了 3 个自定义 Chart.js 插件（L45-332）、美东区间截断、YTD 统计卡片 HTML 拼接以及两套几乎重复且互相覆盖的配色逻辑（`updateTheme` L414 的 `gridColor` 透明度为 `0.03`，`render` L778 为 `0.055`/`0.075`，而 `app.js:700` 在 `render()` 后立刻调 `updateChartsColors()` 用前者覆盖后者并触发二次 Chart `update()`）。
   - **简化方案**：
     - 各弹窗子 Controller 在自身 `init()` 内部按 ID 获取私有 DOM，大幅缩减 `app.js` 的 DOM 声明与透传字典；将 `renderDashboard()` 的弹窗明细渲染移入 `public/js/metric-details.js`；
     - 统一 `chart-renderer.js` 的配色函数 `applyChartTheme()`，消除 `render` 与 `updateTheme` 的重复与二次 `.update()`；将前 330 行的 3 个插件拆至 `public/js/chart-plugins.js`。

4. **前后端重复的日期吸附 fallback 与美东时间推算（补充 T2-3 / T2-4）**
   - **位置**：后端 `routes/api.js:36-52`、`routes/tickers.js:32-53`、`lib/yahoo.js:50-72`、`lib/market-history.js:108-118`；前端 `public/js/date-time.js:2-26, 60-84`、`public/js/transaction-controller.js:32-54`、`public/js/disposal-trial-controller.js:84-94`
   - **认知痛点**：前端 `date-time.js` 总是先于各 Controller 加载，但 `transaction-controller.js` 和 `disposal-trial-controller.js` 仍在文件内各自手写了一套 fallback 的 `snapNearestSundayValue` / `snapValuationValue`。
   - **简化方案**：删除 Controller 内冗余的日期吸附 fallback，统一调用 `window.FundDateTime`；后端统一收口美东时钟与 `previousWeekday` 到单一日期工具模块。

---

### 4.4 需要大量隐性上下文才能理解的代码（历史冻结层、读时写盘、时序潜规则）

1. **主干计算文件里 40% 是冻结的历史兼容算法（V1/V2/V3 结算 + 反向重放猜版本号）**
   - **位置**：`lib/performance-settlement.js:22-312`、`lib/settlement-ledger.js:82-203`、`lib/member-disposal.js:58-97`
   - **认知痛点**：
     - `performance-settlement.js` 混放了三代算法：`settlePerformanceV1`（合并批次轧差，且保留 `0/0` 序列化为 `entryNav: null` 的耗尽批次）、`V2`（独立批次结晶，基准重置为当前净值）、`V3`（独立批次结晶，每份高水位 `nextHighWaterNav` 单调不降）；
     - `settlement-ledger.js:115-189` 为了给早期无 `algorithmVersion` 的记录补版本号，通过分别重放 V1 和 V2 并 `isDeepStrictEqual` 比对持久化 `snapshot` 来反向猜测版本。
     - 新工程师阅读核心结算代码时，极易在三套高度相似的循环中迷失。
   - **简化方案（物理隔离、逻辑零改动）**：
     - **严禁修改 V1/V2/V3 的任何计算逻辑**；
     - 将已冻结的 `settlePerformanceV1`、`settlePerformanceV2` 拆到独立的 `lib/legacy-performance-settlement.js`，让 `lib/performance-settlement.js` 主文件只保留现行 V3 算法与清晰的版本分发入口，并在顶部用注释表格列出 V1/V2/V3 及 `disposalVersion` 1/2 的差异。

2. **“读操作即写磁盘、甚至生成并淘汰备份 ZIP”的隐式副作用**
   - **位置**：`server.js:153-193`（`readDbUnsafe`）、`lib/storage.js:250-267`（`readCustomBenchmarkCache`）、`lib/storage.js:355-420`（`readDb`）、`lib/storage.js:574-580`（`readConfig`）
   - **认知痛点**：常规读取函数内部嵌有多段原地写盘迁移逻辑。特别是 `server.js:153-193` 在首次调用 `readDb()` 时，若触发事件序号或结算账本迁移，会直接调用 `storage.writeSnapshot()`——这意味着一次普通的 `GET /api/state` 请求就可能静默改写磁盘并在 `backups/` 下生成/清理 `snapshot_backup_*.zip`！
   - **简化方案**：将所有数据格式升级与序号迁移收拢为显式的 `ensureLedgerMigrated(storage)` 生命周期步骤，在账本加载/启动或备份导入时显式执行，使运行时的 `read*()` 回归可预期的只读语义。

3. **前端“3 秒延迟软删除 (`pendingDeletes`)”引发的跨 5 文件同步屏障与非标 DOM 属性 `_deleteEventId`**
   - **位置**：`public/js/ledger-actions-controller.js:7-26, 91-121`、`public/js/ledger-renderer.js:128`、`public/js/api.js:14-17`、`public/js/disposal-trial-controller.js:72-80`、`public/js/settlement-controller.js:46-49`、`public/js/ledger-switcher.js:96-99`
   - **认知痛点**：
     - 点击删除流水后有 3 秒倒计时（行透明度设为 `0.2`）。为防止 3 秒内点“出金试算”、“业绩结算”、“切换账本”读到未删状态导致 `previewToken` 签名失效，代码在 5 个文件里到处手写 `await window.FundLedgerActions?.flushPending?.()`，并在 `api.js:15` 写 `!(method === 'DELETE' && url.startsWith('/api/event/'))` 特判防止递归死锁；
     - 定位待删除表格行居然靠遍历 `ledgerTbody` 下所有 `<button>` 查找非标准 DOM 属性 `button._deleteEventId === id`。
   - **简化方案**：
     - 在 `<tr data-event-id="...">` 上使用标准 `dataset.eventId` 定位行；
     - 在 `flushPending()` 内部加防重入 Promise 锁（`if (flushingPromise) return flushingPromise`），统一由 `api.js` 在发请求前自动 flush，清理各业务 Controller 中重复手写的 `flushPending` 样板代码与 URL 字符串特判。

4. **双时区潜规则（美东时间 `America/New_York` vs 北京时间 `Asia/Shanghai`）**
   - **位置**：美东时间：`routes/api.js:36-52`、`lib/yahoo.js:50-72`、`public/js/date-time.js:2-26, 172-183`、`public/js/chart-renderer.js:362-370`；北京时间：`routes/api.js:61-68`、`lib/calculator.js:523-525`、`public/js/member-statement-controller.js:17-19`
   - **认知痛点**：行情、估值日开放（04:05 ET）、图表区间截断及前端 `#settle-date` 默认值使用**美东时间**；而后端校验结算日期上限（`routes/api.js:61`）、估算潜在业绩报酬（`calculator.js:523`）和成员报表默认今日却使用**北京时间**。
   - **简化方案**：在前后端日期工具模块中集中定义并文档化双时区函数：`getMarketEasternDate()`（美股行情与估值日口径）与 `getLedgerBeijingDate()`（账务结算与报表口径），消除各文件散落手写的 `Intl.DateTimeFormat(...).formatToParts(...)`。

5. **跨页面刷新传值的 `sessionStorage` 阅后即焚信箱、Windows 注册表代理 + `curl` 回退与 `--launcher-child` IPC 守护**
   - **位置**：`public/js/ledger-switcher.js:4-12, 102-110` 与 `public/js/settings-controller.js:5-18`、`lib/http-json.js:13-163`、`server.js:1-13, 550-572`、`scripts/launch.js:1-28`
   - **认知痛点**：这三处都是有合理工程原因（整页切账本保留滚动/隐私状态、国内本地代理访问 Yahoo 且不在进程参数暴露密码、Windows 关闭 `.bat` 窗口优雅释放 NAS 文件锁）但缺乏集中说明的隐式机制，特别是 `server.js` 第 1 行在 `require('express')` 之前就做 `--launcher-child` IPC 自杀监听，容易让新工程师摸不着头脑。
   - **简化方案**：
     - 将 `server.js:1-13` 与 `550-572` 的进程守护与信号退出抽为 `lib/process-lifecycle.js`（或在顶部集中注释契约）；
     - 在 `lib/http-json.js` 与 `ledger-switcher.js` 顶部补充简明的设计背景注释，避免后人误删。

---

### 4.5 建议 Neon 接手后的执行批次（按低风险 -> 高收益排序）

| 批次 | 包含任务 | 预期效果与验证重点 |
| :--- | :--- | :--- |
| **Batch 1：零风险降噪与物理隔离** | - 拆分 `settlePerformanceV1/V2` 到 `lib/legacy-performance-settlement.js`<br>- `calculator.js` 入口浅克隆 `db.events` + 用只读函数 `estimateLotsPerformanceFee` 替代 `'estimate-lp'` 虚拟成员<br>- 抽离 `server.js` 头部 `--launcher-child` 生命周期逻辑并补齐 `http-json.js` 契约注释 | 核心计算文件体积与心智负担立减 40%；跑全量 `npm test` 验证历史回放字节级一致 |
| **Batch 2：前端与 DOM 清理（含 T2-2、T2-4）** | - 修正 `index.html` 尾部夹杂的 4 个 Modal、`.metric-label` 静态标题、`#ticker-ath-container` 位置<br>- 修复 `chart-renderer.js` 重复配色与二次 `.update()`，拆出 `chart-plugins.js`<br>- 收口 `flushPending` 防重入锁与 `<tr data-event-id>`，清理重复的日期吸附、`escapeHtml`、双时区 helper 与 `Api` 方法 | 消除 DOM 启动闪动与图表双渲染；重点验证 `npm run demo:build`、`test-css-entry.js`、`test-frontend-syntax.js` |
| **Batch 3：后端职责与读写边界（含 T2-3）** | - 拆分 `server.js` 的 `readDb()` 为 `readCoreDb()` 与 `buildReplayInput()`，移除 `readBaseDb` 补丁，显式化启动迁移<br>- 下沉 `routes/backup.js` 300 行校验至 `lib/backup-import.js`<br>- 提炼 `transaction-service.js` 全额退出编辑转换纯函数；统一后端日期/正则 helper 与 `PUT /api/members` 的 `newId` | 路由层大幅瘦身，消除“GET 请求写盘生备份”与 `readDb` 三重含义；重点跑存储、备份、出金/转让与成员测试 |
| **Batch 4：多账本架构收敛（含 T2-1）** | - `storage.js` 原生分离共享行情/配置与账本私有数据，移除 `lib/ledgers.js` 对 `defaultStorage` 的猴子补丁<br>- 副账本仅实例化纯 API Router / `LedgerContext`，消除完整 Express App 套娃与 `res.json` 双重包装<br>- 抽取 `server.js` 与 `demo/browser/sandbox.js` 共享的数据组装与账本校验层 | 彻底理顺多账本与浏览器沙盒架构；重点跑 `test-multi-ledger.js`、`test-combined-overview.js`、`test-demo-sandbox.js` |
