# 系统架构图

## 1. 整体分层架构

```mermaid
graph TB
    subgraph Browser["浏览器前端"]
        HTML["index.html 单页面 Dashboard"]
        JS_API["api.js HTTP 请求封装"]
        JS_APP["app.js 状态 / 表单 / 流程协调"]
        JS_CHART["chart-renderer.js 归一化走势图"]
        JS_LEDGER["ledger-renderer.js 历史流水表格"]
        JS_MEMBER["member-renderer.js 成员资产卡片"]
        JS_TICKER["ticker-panel.js 标的行情面板"]
        JS_SETTLE["settlement-controller.js 业绩结算 UI"]
        CSS["13 个 CSS 模块 主题/动画/响应式"]
    end

    subgraph Server["Express 服务层 server.js"]
        CACHE["内存缓存层 _stateCache / _stateDirty"]
        SYNC["启动同步 汇率 + 指数"]
    end

    subgraph Routes["API 路由层 routes/"]
        R_TX["transactions.js 出入金/估值/转让/删改"]
        R_SETTLE["settlements.js 业绩结算预览/确认/冲销"]
        R_MEMBER["members.js 成员增删改/GP指定"]
        R_TICKER["tickers.js 标的配置/ATH缓存"]
        R_SETTING["settings.js 汇率/基准配置"]
        R_BACKUP["backup.js ZIP导出/导入校验"]
    end

    subgraph Lib["核心业务层 lib/"]
        CALC["calculator.js 事件溯源重放引擎 Decimal.js精确计算"]
        DISPOSAL["member-disposal.js 出金/转让统一处置"]
        PERF["performance-settlement.js v1/v2/v3冻结算法"]
        POLICY["performance-fee-policy.js 费率/快照策略"]
        LEDGER["settlement-ledger.js 算法版本迁移/快照校验"]
        ORDER["event-order.js 顺序键/旧账本迁移"]
        ERRORS["api-errors.js 公共错误信封/类型"]
        STORAGE["storage.js 原子写入/事务日志/备份"]
        YAHOO["yahoo.js Yahoo Finance抓取 汇率多源降级"]
    end

    subgraph Data["持久化数据层 data/"]
        DB["db.json 成员/普通事件/业绩报酬配置"]
        CNH_CACHE["cnh-rate-cache.json 当前汇率缓存"]
        CONFIG["config.json 标的配置"]
        INDEX_CACHE["index-cache.json 指数历史收盘缓存"]
        CUSTOM_BENCH_CACHE["custom-benchmark-cache.json 自定义标的历史缓存"]
        SETTLEMENTS["settlements.json 结算/冲销审计记录"]
        TICKER_CACHE["ticker-cache.json 标的行情缓存"]
        MARKER[".settlements-initialized 账本初始化标记"]
    end

    subgraph Backup["备份保护层 backups/"]
        ZIP["snapshot_backup_*.zip 三文件完整快照 滚动保留15份"]
        JOURNAL[".snapshot-transaction.json 崩溃恢复事务日志"]
    end

    subgraph External["外部数据源"]
        YAHOO_API["Yahoo Finance API 指数/标的/汇率"]
        ER_API["ExchangeRate API + Frankfurter + Jsdelivr CDN"]
    end

    Browser -->|HTTP JSON API| Server
    Server --> Routes
    Routes --> Lib
    CALC --> PERF
    CALC --> DISPOSAL
    CALC --> POLICY
    CALC --> ORDER
    DISPOSAL --> PERF
    PERF --> POLICY
    LEDGER --> CALC
    LEDGER --> ORDER
    Routes --> ERRORS
    Lib --> Data
    STORAGE --> Backup
    YAHOO --> External
```

---

## 2. 事件溯源核心数据流

```mermaid
flowchart LR
    subgraph Input["事件录入"]
        D["入金 deposit"]
        W["出金 withdraw"]
        V["估值 valuation"]
        T["转让 transfer"]
        S["结算 settlement"]
    end

    subgraph EventStore["事件账本"]
        ES["db.json 普通 events<br/>+ settlements.json 不可直接修改的结算 records"]
    end

    subgraph Replay["全量重放引擎"]
        SORT["按日期 + sequenceNumber 排序<br/>旧数据迁移前回退 createdAt/数组顺序"]
        LOOP["逐事件遍历"]
        DEC["Decimal.js precision:40"]
    end

    subgraph State["派生状态"]
        NAV["总资产 / 总份额 / 单位净值"]
        MEM["各成员份额 / 资产 / 盈亏"]
        HIST["NAV 历史走势"]
        BENCH["SP500 / NDX / 双自定义组合归一化对比"]
        LOT["LP 批次明细 / 高水位"]
    end

    D & W & V & T & S -->|新增；未锁定普通事件可删改并级联重算| ES
    ES -->|读取| SORT
    SORT --> LOOP --> DEC
    DEC --> NAV & MEM & HIST & BENCH & LOT
```

---

## 3. 数据写入安全机制

```mermaid
flowchart TD
    START["API 写入请求"] --> VALIDATE["全字段输入校验 + 当前/历史GP引用不变量"]
    VALIDATE -->|不通过| REJECT["400 拒绝"]
    VALIDATE -->|通过| LEDGER_CHECK["findLedgerIssue 全账本一致性校验"]
    LEDGER_CHECK -->|余额不足 / 费用不足| REJECT
    LEDGER_CHECK -->|通过| LOCK_CHECK["结算锁账检查"]
    LOCK_CHECK -->|在锁定期内| REJECT_LOCK["409 锁账拒绝"]
    LOCK_CHECK -->|通过| BACKUP["writeCoreBackup 创建三文件 ZIP 快照"]
    BACKUP --> TEMP["prepareTempFile 写入临时文件 + fsync"]
    TEMP --> RENAME["rename 原子替换"]
    RENAME --> CACHE_INV["清除内存缓存 _stateCache = null"]
    CACHE_INV --> SUCCESS["200 成功"]
    BACKUP -->|失败| ABORT["中止 不修改任何文件"]
    TEMP -->|失败| CLEANUP["清理临时文件"]
    RENAME -->|失败| CLEANUP
```

---

## 4. 业绩结算算法版本体系

```mermaid
flowchart TD
    subgraph Frozen["冻结算法 - 只读不可修改"]
        V1["v1 成员汇总收费<br/>全部LP批次合并后统一计算门槛与报酬"]
        V2["v2 逐批独立核算<br/>每个入金批次独立计算 盈亏不互相对冲"]
    end

    subgraph Current["当前算法"]
        V3["v3 高水位NAV分离<br/>计费周期重启 高水位NAV只升不降 同水位批次可合并"]
    end

    subgraph Migration["版本迁移器"]
        M_READ["读取无版本旧记录"]
        M_REPLAY["分别用 v1 v2 重放"]
        M_COMPARE["与锁定快照精确比对"]
        M_MATCH{"唯一匹配?"}
        M_ASSIGN["补充 algorithmVersion"]
        M_REJECT["拒绝加载"]
    end

    NEW_SETTLE["新结算确认"] -->|algorithmVersion 3| V3
    HISTORY["历史记录回放"] -->|按记录自身版本| V1
    HISTORY -->|按记录自身版本| V2
    HISTORY -->|按记录自身版本| V3

    M_READ --> M_REPLAY --> M_COMPARE --> M_MATCH
    M_MATCH -->|是| M_ASSIGN
    M_MATCH -->|否 或 多版本状态不同| M_REJECT
```

---

## 5. 三文件原子事务 writeSnapshot

```mermaid
sequenceDiagram
    participant API as API 请求
    participant S as storage.js
    participant FS as 文件系统
    participant J as 事务日志

    API->>S: writeSnapshot db config settlements
    S->>S: writeCoreBackup 创建 ZIP 快照
    S->>FS: prepareTempFile db + fsync
    S->>FS: prepareTempFile config + fsync
    S->>FS: prepareTempFile settlements + fsync
    S->>FS: prepareTempFile marker + fsync

    Note over S,J: 记录旧文件内容到事务日志
    S->>J: 写入 .snapshot-transaction.json

    Note over S,FS: 逐个原子替换
    S->>FS: rename tmp_db 为 db.json
    S->>FS: rename tmp_config 为 config.json
    S->>FS: rename tmp_settlements 为 settlements.json
    S->>FS: rename tmp_marker 为 .settlements-initialized

    S->>J: 删除事务日志

    Note over S,J: 如果中途崩溃
    Note over S,J: 下次启动时发现事务日志
    S->>J: 读取日志中的旧内容
    S->>FS: 用旧内容恢复全部 4 个文件
    S->>J: 删除事务日志 回到完整旧版本
```

---

## 6. 文件依赖关系

```mermaid
graph LR
    SERVER["server.js"] --> STORAGE["storage.js"]
    SERVER --> CALC["calculator.js"]
    SERVER --> SETTLE_L["settlement-ledger.js"]
    SERVER --> YAHOO["yahoo.js"]
    SERVER --> R_API["routes/api.js"]

    R_API --> R_TX["transactions.js"]
    R_API --> R_SET["settlements.js"]
    R_API --> R_MEM["members.js"]
    R_API --> R_TK["tickers.js"]
    R_API --> R_STG["settings.js"]
    R_API --> R_BK["backup.js"]

    CALC --> PERF["performance-settlement.js"]
    CALC --> DISPOSAL["member-disposal.js"]
    CALC --> POLICY["performance-fee-policy.js"]
    CALC --> ORDER["event-order.js"]
    STORAGE --> POLICY
    POLICY --> ERRORS["api-errors.js"]
    SETTLE_L --> CALC
    SETTLE_L --> PERF
    SETTLE_L --> ORDER
    SERVER --> ERRORS
    R_BK --> SETTLE_L
    R_BK --> POLICY
    R_BK --> ORDER
    R_SET --> PERF
    R_SET --> POLICY

    TEST_PERF["test/test-replay-performance.js"] --> BUDGET["replay-performance-budget.js"]
    TEST_PERF --> CALC
```

---

## 7. 部署与安全边界

```mermaid
flowchart LR
    BROWSER["本机浏览器"] -->|127.0.0.1 HTTP| SERVER_LOCAL["Express 单用户服务"]
    SERVER_LOCAL --> DATA_LOCAL["本机 data/ 与 backups/"]
    REMOTE["局域网 / 公网客户端"] -. 默认不可连接 .-> SERVER_LOCAL
    PROXY["反向代理 / 端口转发 / 修改监听地址"] -->|扩大暴露前必须先加固| GATE["认证 + CSRF + Host/Origin + 限流"]
    GATE --> SERVER_LOCAL
```

- 默认监听 `127.0.0.1`，当前设计目标是本机、单用户部署；
- CSP 和本地化依赖保护浏览器资源执行边界，不等同于用户身份认证；
- 不得通过反向代理、端口转发或修改监听地址直接暴露服务；
- 任何网络暴露必须先完成 TASK-008，并重新评估 TLS、会话和审计要求。
