# 多账本架构说明

## 1. 界面与交互

- 标题下方显示当前账本名称；打开下拉菜单可切换账本或进入“管理账本”，点击旁边的“总览”按钮可打开“合并总览”。
- 首次打开默认进入默认账本（`default`）；切换账本通过页面 URL 的 `ledger` 参数保存在当前标签页并重新加载，以清除旧表单、未提交预览与页面状态。
- 切换账本时仅做一次性的隐私模式与滚动位置传递，普通刷新仍回到默认隐私状态；切换不影响其他标签页当前选中的账本。

## 2. 目录与持久化布局

- **默认账本（`default`）**：保留原有 `data/db.json`、`data/settlements.json` 及 `backups/` 根目录，不搬迁既有数据；重命名后的名称写入 `data/ledger.json`。
- **副账本（`ledger-2` .. `ledger-999`）**：按顺序存放在 `data/ledger-N/`，独立保存各自的 `db.json`、`settlements.json`、`ledger.json`（原子发布标记）、`.settlements-initialized`、`.snapshot-transaction.json` 与 `.fund-manager.lock/`；滚动快照存放在外层 `backups/ledger-N/`（设置 `FUND_BACKUP_DIR` 时同样使用该目录下的账本子目录）。
- **共享配置与行情缓存**：`config.json`、`market-history.json`、`index-cache.json`、`custom-benchmark-cache.json`、`cnh-rate-cache.json`、`ticker-cache.json` 共用默认 `data/` 目录；副账本目录内的 `config.json` 仅作事务恢复与备份快照副本，副账本导入备份时不会覆盖共享的基准与自选标的配置。
- **并发与隔离**：请求通过 `X-Ledger-Id` 请求头或 `ledger` 查询参数显式选择账本，拒绝无效 ID、符号链接/目录别名或冲突选择，绝不静默回退到默认账本。各账本拥有独立目录锁、计算缓存、事件顺序号与预览签名，同时共享行情同步队列与自选标的刷新工作器。

## 3. 跨账本成员编号与合并总览

- 新建成员自动分配 6 位数字编号（`100000`–`999999`，首位非零），避免与当前全部账本既有编号冲突；同一账本内编号唯一。
- 同一个自然人在不同账本中可手动设置为相同的 6 位成员编号，合并总览（`/api/ledgers/combined`）按成员编号汇总跨账本资产、在管本金、历史现金流收益与分账本明细；仅姓名相同但编号不同的成员保持独立展示。
- 修改成员编号时（单条或批量），后端在 `lib/member-identifiers.js` 中对普通事件、GP 配置、历史报酬参数、LP 名单与锁定结算快照做结构化引用重写，并通过迁移前后全量重放深度等价校验后原子提交。
- 历史旧编号（`me`/`mother`/`father` 或早期 `mem_<UUID>`）可通过离线迁移脚本 `scripts/migrate-member-identifiers.js` 在停服后一键迁移（迁移前自动留存逐字节原始 ZIP 备份与编号映射表）。

## 4. 安全边界与测试覆盖

- 多账本属于同一本机系统内的记账数据分组，不提供多用户登录或权限隔离，沿用现有回环限定与 `localRequestPolicy` 校验。
- 回归测试：`test/test-ledgers.js`、`test/test-ledger-workers.js`、`test/test-ledger-startup-sync.js`、`test/test-ledger-switcher.js`、`test/test-combined-overview.js`、`test/test-member-identifiers.js`、`test/test-member-batch.js` 与 `test/test-settings-privacy.js`。
