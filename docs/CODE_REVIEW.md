# 代码审查报告

> 审查人：Claude Opus 4.6 Thinking
>
> 审查日期：2026-08-11
>
> 系统版本：v3.11.0
>
> 审查范围：后端 10 个 `lib/` 模块、7 个 `routes/` 模块、入口 `server.js`、前端 22 个 JS + 13 个 CSS 模块、24 个测试脚本

---

## 总体评价

这是一个完成度极高、工程纪律极为严谨的个人/家庭级金融系统。在以下方面达到了接近专业金融软件的水准：

| 维度 | 评分 | 说明 |
|------|------|------|
| 🏛 架构设计 | ⭐⭐⭐⭐⭐ | 事件溯源 + 完整重放，分层清晰 |
| 🔢 金融精度 | ⭐⭐⭐⭐⭐ | Decimal.js precision:40 全程精确计算 |
| 💾 数据安全 | ⭐⭐⭐⭐⭐ | 原子写入 + 事务日志 + ZIP 快照 + 崩溃恢复 |
| 🧪 测试覆盖 | ⭐⭐⭐⭐½ | 24 个脚本覆盖领域逻辑、API 集成、性能预算 |
| 🔒 安全策略 | ⭐⭐⭐⭐ | CSP/nosniff/本地依赖/输入校验，但限于本地部署 |
| 📝 文档质量 | ⭐⭐⭐⭐⭐ | 架构图、变更日志、技术债追踪一应俱全 |
| 🧹 代码质量 | ⭐⭐⭐⭐ | 命名规范，职责明确，但有些函数偏长 |
| 🚀 可维护性 | ⭐⭐⭐⭐ | 模块拆分到位，已知债务有记录和优先级 |

---

## 一、亮点 — 做得非常好的部分

### 1. 事件溯源架构（Event Sourcing）

系统的核心设计理念非常扎实：所有财务变动（入金/出金/估值/转让/结算）作为不可变事件存储在 `db.json` 和 `settlements.json` 中，全局状态通过 `lib/calculator.js` 的 `calculateStateFromDb` 完整重放派生。这意味着：

- **任意历史修改都能级联重算**，不存在状态不一致
- **审计完全透明**，任何数值都可追溯到具体事件
- **算法升级不破坏历史**，v1/v2/v3 冻结算法保留完整重放能力

### 2. 金融级数据精度

```javascript
// calculator.js L10
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
```

全程使用 `Decimal.js` 替代浮点数，precision 40 位。金额只在 API 输出边界才做 `output(value, decimalPlaces)` 截断。这是专业做法，避免了 `0.1 + 0.2 !== 0.3` 这类常见金融 bug。

### 3. 三文件原子事务 + 崩溃恢复

`lib/storage.js` 中的 `writeSnapshot` 实现了一个完整的 WAL（Write-Ahead Log）模式：

- `prepareTempFile` → fsync → rename 保证单文件原子性
- `.snapshot-transaction.json` 事务日志在替换前记录旧数据
- 中途崩溃时 `recoverInterruptedSnapshot` 在下次启动自动回滚
- `writeCoreBackup` 每次写入前生成 ZIP 快照，滚动保留 15 份

这套机制在单用户本地部署下，数据安全等级已经很高了。

### 4. 结算算法版本冻结体系

`lib/settlement-ledger.js` 的 `migrateSettlementLedger` 是一个精心设计的版本迁移器：

- 旧的无版本记录通过与锁定快照比对来推断 v1/v2
- 如果多版本都能匹配但结算后状态不同，拒绝自动迁移
- 已冲销的结算用快照形状推断版本，不依赖重放

这保证了**已确认的历史财务数据永远不会被代码升级意外改写**。

### 5. 输入校验的纵深防御

从路由层到存储层，校验层层递进：

- 路由层：类型/范围/日期格式/周日限制/锁账期检查
- API 层：`findLedgerIssue` 全账本一致性校验（余额不足、费用不足）
- 存储层：`assertValidConfiguredGp`、`assertValidDisposalFeeReferences` 不变量断言
- 导入层：300+ 行的 ZIP 导入校验，覆盖事件类型白名单、成员引用、金额合法性

### 6. 性能预算与可观测性

`lib/replay-performance-budget.js` 配合测试建立了三档重放性能预算：

```
典型账本:       37 events    →  75.6ms  (5.0% of budget)
家庭建议上限:   231 events   → 2271.3ms (28.4%)
导入硬上限:     10000 events → 5848.2ms (39.0%)
```

这是对 TD-002 技术债的务实回应——不过早优化，但设好警戒线。

---

## 二、改进建议

### 🟡 P2：中等优先级

#### 1. `server.js` 中的 `readDbUnsafe` 职责过重

`readDbUnsafe` (L118–166) 在一个函数中完成了：迁移检测、旧结算事件拆分、事件序列号迁移、高水位校验/修复、结算账本版本迁移、合并。单个函数约 50 行并包含 6 个 `if` 分支，首次读取时可能触发多次 `writeSnapshot`。

**建议**：把 `_settlementLedgerValidated` 分支内的逻辑提取为 `performFirstLoadMigrations(db, settlementLedger)` 独立函数，让 `readDbUnsafe` 只负责"读取 + 调用迁移 + 合并"的编排。

#### 2. 路由处理函数中的 try/catch 模式重复

每个路由 handler 都是 `try { ... } catch (error) { handleApiError(error, req, res, next); }` 的模式。7 个路由文件中重复了约 20 次。

**建议**：引入一个简单的 wrapper：

```javascript
function wrapHandler(fn) {
  return (req, res, next) => {
    try { fn(req, res, next); }
    catch (error) { handleApiError(error, req, res, next); }
  };
}
```

既能减少样板代码，也降低了遗漏 catch 的风险。

#### 3. `JSON.parse(JSON.stringify(...))` 深拷贝的性能与安全

`clone(value)` 在整个 codebase 中被大量使用（`storage.js` 中的 `readDb`/`readSettlements`/`readConfig` 每次读取都 clone）。对于当前数据规模（db.json ~45KB）完全没问题，但：

- `JSON.parse(JSON.stringify)` 不能克隆 `undefined` 值、`Date` 对象等
- 在高频读取路径上有隐式的 GC 压力

**建议**：当前规模下可以保持现状，但如果数据量接近导入上限（10000 事件），考虑使用 `structuredClone`（Node 17+）或在 `getState()` 缓存层做冻结 + 浅拷贝。

#### 4. 前端单体 HTML 文件

`public/index.html` 有 58KB，承载了所有页面的 DOM 结构。虽然已在 `TECHNICAL_DEBT.md` 中记录为 TD-005，但值得强调：随着功能增加，DOM 的加载时间、脚本的初始化成本和维护冲突成本会持续上升。

**建议**：短期可以将各页面的 HTML 片段改为 JS 模块中的 template literals，通过路由切换时按需注入，避免一次性加载所有 DOM。

### 🟢 P3：低优先级

#### 5. 测试运行缺少统一 runner

`package.json` 中 `test` 脚本是 24 个 `node test/xxx.js &&` 的串联（一行约 1300 字符）。已记录为 TD-006。

**建议**：即便不引入 mocha/jest，也可以写一个 `test/run-all.js` 来自动发现并执行 `test/test-*.js`，带颜色输出和耗时统计，同时简化 `package.json`。

#### 6. `yahoo.js` 中 User-Agent 字符串重复

同一个 Chrome UA 字符串在 `lib/yahoo.js` 中出现了 5 次。

**建议**：提取为模块级常量 `const USER_AGENT = '...'`。

#### 7. 缺少请求速率限制

虽然默认监听 `127.0.0.1` 且已在 TD-003 中声明，但即便是本地部署，恶意浏览器扩展或本地恶意软件仍可发送请求。

**建议**：至少为写入类 API（POST/PUT/DELETE）添加一个简单的内存速率限制（如 100 req/min），成本极低但增加了一层防护。

#### 8. 备份 ZIP 文件堆积在项目根目录

根目录下有 3 个手动打包的 ZIP 文件（`基金账目管理系统_*.zip`），加起来约 3MB。它们不在 `.gitignore` 中。

**建议**：将手动打包的 ZIP 加入 `.gitignore`，或移到专门的 releases 目录。

---

## 三、安全扫描

| 项目 | 状态 | 说明 |
|------|------|------|
| SQL/NoSQL 注入 | ✅ 不适用 | 纯 JSON 文件存储 |
| 命令注入 | ✅ 已防护 | `execFile` 参数化调用 curl |
| XSS | ⚠️ 需关注 | CSP 已限制，但前端大量 `innerHTML` 使用需确认无用户输入注入 |
| CSRF | ⚠️ TD-003 | 本地部署可接受，网络暴露前必须解决 |
| 路径遍历 | ✅ 已防护 | 所有文件路径硬编码，导入 ZIP 用 adm-zip 的 `getEntry` |
| DoS（应用层）| ⚠️ 有限防护 | `express.json({ limit: '5mb' })`、ZIP 限 10MB、事件限 10000 条 |
| 依赖安全 | ✅ 良好 | 依赖精简（6 个），版本锁定 |

---

## 四、测试健康度

✅ **24 个测试脚本全部通过**，覆盖了：

- 核心数学模型（双轨会计、份额守恒）
- 业绩结算三个冻结版本 + 迁移
- API 输入校验回归（39 个场景）
- API 集成端到端
- 存储原子性与崩溃恢复
- 重放性能预算
- 前端语法与资源完整性
- CSP 策略合规
- UI 组件交互回归

测试质量很高，尤其是 `test/test-performance-settlement.js`（32KB，覆盖了 v1→v3 全部边界用例）。

---

## 五、架构总结

```
浏览器 SPA (单文件 HTML + 22 个 JS 模块)
    ↓ HTTP JSON
Express (server.js, 内存缓存层)
    ↓
6 个路由模块 (transactions/settlements/members/tickers/settings/backup)
    ↓
8 个业务核心模块 (calculator/storage/performance-settlement/...)
    ↓
JSON 文件持久层 (db.json + config.json + settlements.json + 缓存文件)
    + ZIP 事务备份 (backups/)
    + 外部数据 (Yahoo Finance API + 多源汇率)
```

**这是一个以"正确性优先"为设计哲学的系统**——宁可多一次全量重放也不容忍累积误差，宁可写前多创建一份 ZIP 也不冒数据丢失的风险。对于家庭基金这个使用场景，这是完全正确的取舍。
