# 全量代码 Review 报告 — family-fund-manager

> **归档说明**：#1–#4 已销项；v3.17.1 补充修复并独立复核 #6、#14。2026-10-04 补充修复并独立复核 #9、#12，见[修复验收记录](./CODE_REVIEW_2026-10-04.md)。其余处理状态统一见上级审查总表。 [返回审查总表](../CODE_REVIEW.md)。

> v3.18.4 补充：#5、#7、#8、#15 已修复并完成连续两轮独立复核，见[后续验收记录](./CODE_REVIEW_2026-10-04_FOLLOWUP.md)。下方原始问题与修复建议保留为历史描述。

范围：`server.js`、`lib/*`（存储 / 回放计算 / 业绩结算 / 处置 / 行情）、`routes/*`、`public/js` 核心模块。

整体评价：架构清晰（事件溯源 + 原子写 + 独立结算账本），金额全程 `decimal.js`，写路径均先"克隆→回放校验→再落盘"，前端用 `textContent` / `escapeHtml` 渲染，XSS 面很小。以下按严重度列出问题。

**销项复核（2026-10-03）**：#1–#4 已修复并经独立审查通过，予以销项。#1、#2 的修复已包含在提交 `7e0dfd9`；#3、#4 位于 `13791db`。全量 `npm test` 通过，额外独立验证了带业绩费出金、内嵌及独立结算账本的冲销恢复、快照篡改、加密及不支持的 ZIP 压缩格式。以下 #1–#4 的问题描述与建议保留为历史记录，不代表当前实现仍存在这些问题。后续 v3.17.1 已修复并复核 #6、#14，其余待处理项未在本次逐项重新审查。

---

## 🔴 P0 — 账务正确性

### 1. 部分出金/转让可超额提取，导致 LP 份额为负（已销项）

**修复与验收**：`disposeMemberPosition` 将实际可支付金额限制在 LP 税后可用份额与已有 carry 份额之内；写入前回放拒绝申请金额超过实际可结算金额的账本，并逐事件检查成员总份额、LP 份额及 carry 份额是否为负。计算层及 API 回归测试覆盖超额出金、转让和备份导入，均通过。销项针对代码缺陷；未据此宣称已扫描或修复用户现有账本。

[member-disposal.js:L80-L115](../../../lib/member-disposal.js) + [transactions.js:L85-L92](../../../routes/transactions.js)

当申请金额 `R` 落在 **(LP 税后净值, 账户毛值)** 区间且该成员没有 carry 份额时：

- `previewDisposalFee` 的 ratio 被截断为 1，`disposal.cashShares = L − f`（f 为业绩报酬份额）；
- `carrySharesDisposed = R/N − (L − f) > 0`，但成员 **没有 carry 可扣**；
- `member.shares = L − (R/N + f) < 0`，现金仍按 `R` 全额支付。

路由侧只校验 `R ≤ _accountValueBefore`（**毛值**），而 [findLedgerIssue](../../../routes/api.js) 只检查 `_grossAmount < amount` 与 `_unpaidPerformanceFeeShares`，两者都不触发。

复现（`repro_negative_shares.js`（原审查人的本机复现脚本，未纳入仓库））：LP 入金 1000，一年后 NAV 翻倍，毛值 2000，税后约 1766。

| 申请出金 | 是否放行 | LP 剩余份额 |
|---|---|---|
| 1500 | ✅ | 150.26 |
| 1800 | ✅ | **−17.37** |
| 1950 | ✅ | **−92.37** |

超出部分实际由其他成员的净值买单。

**建议**：
- 校验上限改为"可提取净额" = `(lpShares − feeShares + carryShares) × NAV`，由 `disposeMemberPosition` 输出 `_maxWithdrawable`；
- `findLedgerIssue` 增加兜底：任何成员 `shares / lpShares / carryShares < −ε` 即拒绝；
- 补一条单元测试覆盖此区间。

### 2. 业绩结算日期未限制为 ≤ 今天（已销项）

**修复与验收**：新增结算及备份恢复中的有效结算均复用 `rejectFutureSettlementDate`，按北京时间拒绝晚于今天的结算日期。已冲销结算作为审计历史保留，不再锁账或影响有效余额。API 测试覆盖日期边界、两种备份格式及已冲销记录，均通过。

[settlements.js:L12-L28](../../../routes/settlements.js)

`date` 只校验格式和"晚于上次结算"。录入未来日期（如 `2030-12-31`）后，[rejectLockedPeriod](../../../routes/api.js) 会把该日期之前的 **所有** 新增 / 修改 / 删除全部锁死，hurdle 也会按未来天数计提。只能靠"撤销最近结算"解锁。

**建议**：服务端拒绝 `date > 今天`（或 `> latestValuationDate()`）。

---

## 🟠 P1 — 健壮性 / 数据完整性

### 3. 备份导入对事件字段是白名单校验 + 原样透传（已销项）

**修复与验收**：新增 `lib/backup-import.js`，按事件类型重建对象，清除未知字段及计算字段；复用 `normalizeRemark`，校验 `fullExit`、`requestedGrossAmount`、业绩费参数快照、`lpMembers`、结算快照和 transfer 的 `cnhAmount`。内嵌与独立结算记录采用同一规范化逻辑，另增加跨账本 ID 冲突和事件总数检查。新增导入测试及现有 HTTP 集成测试均通过，旧备份迁移顺序和结算快照回放校验保持有效。

[backup.js:L133-L181、L216](../../../routes/backup.js)

- 事件对象原样写入 `db.events`，任意多余字段（`fullExit`、`requestedGrossAmount`、`_xxx` 计算字段、超长 `remark`）都会进入账本；
- `fullExit` / `requestedGrossAmount` 会直接改变回放语义，未校验；
- `remark` 无类型/长度限制（新增接口经过 `normalizeRemark`，导入绕过了）；
- 结算记录的 `lpMembers` 未校验是否属于 `memberIds`；
- transfer 的 `cnhAmount` 未校验。

**建议**：导入时按事件类型 **重建对象**（只拷贝已知字段），复用 `normalizeRemark`。

### 4. ZIP 解压大小依赖头部声明值（已销项）

**修复与验收**：导入不再调用无应用预算约束的 `getData()`；DEFLATE 解压通过 `maxOutputLength` 限制实际输出，三个数据文件共享 10MB 预算，STORED 文件检查实际长度，并核对压缩数据长度、解压后长度及 CRC。伪造头部大小、超限解压、跨文件超限和损坏 CRC 均被拒绝，拒绝时不写入账本或缓存；STORED 与数据描述符标志兼容性测试通过。

[backup.js:L77-L81](../../../routes/backup.js) 使用 `header.size`，这个值可以伪造；`getData()` 实际解压不受限，存在 zip bomb 风险。本地应用风险较低，但建议解压后再检查 `Buffer.length`。

### 5. 计算层抛出的业务错误会变成 500

`configuredPerformanceFeeRates`（[performance-fee-policy.js:L26](../../../lib/performance-fee-policy.js)）、calculator 中的 NAV 校验等抛的是普通 `Error`，经 `handleApiError` 处理后变成 500 + "服务器内部错误"，用户看不到原因。**建议**改成 `InputError` / `ConflictError`，或在路由层包一层转换。

### 6. 编辑 transfer 时总会重算 `cnhAmount`（已销项）

**修复与验收（v3.17.1）**：仅实际变更金额或汇率才重新换算。前端缺汇率的旧记录使用历史实付金额推导汇率；保留全额转让的净额/原申请毛额基准，并兼容缺原申请毛额的旧全额记录。回归覆盖部分/收费全额、稀疏/完整编辑、旧格式、重复备注编辑及真正变更金额或汇率，核对成员权益与人民币台账不变。

[transactions.js:L422](../../../routes/transactions.js)：只改备注也会覆盖 `cnhAmount`。正常数据下结果相同，但如果历史数据的 `cnhAmount` 来自导入或手工修正，会被静默改掉。建议仅在 `amount` / `cnhRate` 变化时重算。

### 7. `POST /api/transaction` 校验顺序

[transactions.js:L25](../../../routes/transactions.js)：在 `isValidDate` 之前先调用 `rejectLockedPeriod(db, date)`，传入非字符串时会做字符串比较。建议把锁账检查移到日期校验之后（transfer 路由同理）。

---

## 🟡 P2 — 安全 / 性能 / 可维护性

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 8 | [http-json.js:L67](../../../lib/http-json.js) | 代理凭据通过 curl 命令行参数传递，`ps` 可见 | 改用 `env` 的 `HTTPS_PROXY` 传给子进程 |
| 9 | [http-json.js:L84-L99](../../../lib/http-json.js) | `directJson` 响应体无大小上限 | 累计超过 10MB 时 `destroy` |
| 10 | [demo.js:L26-L29](../../../routes/demo.js) | 演示账本是静态的，却每次请求都完整回放 | 启动时计算一次并缓存 |
| 11 | [market-history.js](../../../lib/market-history.js) / 同步 worker | 期望收盘日恰逢美股假日（如 Good Friday）时，每次同步都会重新请求 | 记录"已探测无数据"的日期 |
| 12 | [yahoo.js:L39-L50](../../../lib/yahoo.js)、`findCloseBefore` | 每次查价都对全部键做 `filter + sort`，复杂度 O(n log n) | 预排序后二分查找 |
| 13 | [app.js:L412-L413](../../../public/js/app.js) | `getMembers` / `getState` 串行请求 | `Promise.all` |
| 14（已销项，提升至 P1） | 所有页面及 API | 原缺少 Host / Origin 请求来源防护 | v3.17.1 在解析请求体和静态资产前验证字面本机 Host、实际端口及同源 Origin，拒绝跨站 Fetch Metadata、重复头和不透明 Origin；HTTP 回归核对拒绝后核心备份数据不变 |
| 15 | [api.js:L21](../../../routes/api.js) | `lastIssuedEventSequence` 是进程内状态，多实例下失效 | 单实例部署可接受，建议在文档中注明 |

---

## ✅ 做得好的地方

- 所有写接口都先在克隆上回放校验，再原子落盘；
- 结算账本独立文件 + 冲销记录（只追加），可审计；
- `sequenceNumber` 高水位同时考虑 db / ledger / 内存三方；
- 行情缓存采用 stale-while-revalidate，并发刷新已合并；
- 错误信封统一（`code` + `message`），500 错误不向客户端暴露内部细节；
- 前端动态内容一致使用 `escapeHtml` / `textContent`。

---

## 建议修复顺序

1. **#5、#7**：业务错误分类、日期校验顺序；
2. **#8、#10、#11、#13、#15**：按部署场景和实际需求安排安全、性能与可维护性改进。

#6、#14 的补充验收：两轮独立审核通过；第一轮发现的旧全额记录缺原申请金额时标记丢失已补修。完整 31 个测试脚本通过；真实 HTTP 防护回归由主代理执行，独立审核另验证解析边界和账务回归。

#1–#4 已销项，不再列入待修复队列。如需排查修复前是否已产生异常账目，可另行扫描现有账本；本次销项复核未执行该数据检查。
