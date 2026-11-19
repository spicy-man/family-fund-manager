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
