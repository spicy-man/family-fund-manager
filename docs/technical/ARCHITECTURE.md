# 系统架构设计白皮书

> **系统版本**：v3.16.1
>
> **最后更新**：2026-09-03
>
> **设计哲学**：正确性绝对优先、事件溯源驱动、金融级精度保真、WAL 事务保障、零外部运维依赖（No-Build & 100% 离线自治）。

---

## 1. 整体分层架构

```mermaid
graph TB
    subgraph Browser["浏览器前端 (原生 No-Build SPA)"]
        HTML["index.html 主仪表盘 + 首次引导模态框"]
        DEMO_UI["/demo 独立只读演示环境"]
        JS_SHELL["app-shell-controller.js / navigation.js 页面容器与导航"]
        JS_APP["app.js / modal-manager.js 状态协调与模态框生命周期"]
        JS_CHART["chart-renderer.js / chart-controls.js 走势图与周期缩放"]
        JS_LEDGER["ledger-renderer.js / operation-panel.js 流水明细与快捷操作"]
        JS_MEMBER["member-renderer.js 成员双轨权益与本金收益卡片"]
        JS_TICKER["ticker-panel.js / ticker-config-controller.js 行情与标的配置"]
        JS_SETTLE["settlement-controller.js 业绩结算预览/确认/冲销 UI"]
        JS_CUSTOM["custom-benchmark-controller.js 双自定义对比组合配置"]
        JS_DEMO["demo-mode.js 只读沙箱控制与表单锁定"]
        JS_ONBOARD["onboarding-controller.js 空账本首次引导流程"]
        JS_CORE["api.js / submission-guard.js / ui-utils.js 等共 25 个 JS 控制器"]
        CSS["13 个 CSS 模块 主题/动效/移动响应式 (本地闭环)"]
    end

    subgraph Server["Express 服务层 server.js"]
        CACHE["内存缓存层 _stateCache / _stateDirty"]
        SYNC["启动同步与定时抓取：汇率 + 标的 ATH + 逐日行情历史"]
        MIDDLEWARE["CSP 严格安全标头 + JSON 体积限制 (5MB) + 统一错误响应信封"]
    end

    subgraph Routes["API 路由层 routes/"]
        R_TX["transactions.js 出入金/估值/转让/流水删改"]
        R_SETTLE["settlements.js 业绩结算预览/确认/倒序冲销"]
        R_MEMBER["members.js 成员增删改/GP指定与不变量校验"]
        R_TICKER["tickers.js 自选标的配置/ATH缓存/行情刷新"]
        R_SETTING["settings.js 基础配置/汇率手动覆盖与回退"]
        R_CUSTOM["custom-benchmark.js 双自定义对标组合配置与行情"]
        R_BACKUP["backup.js 三文件 ZIP 导出/校验/原子导入恢复"]
        R_DEMO["demo.js /demo 独立只读沙箱接口与离线快照"]
    end

    subgraph Lib["核心业务层 lib/"]
        CALC["calculator.js 事件溯源重放引擎 (Decimal.js 40位高精)"]
        DISPOSAL["member-disposal.js 出金/转让统一批次处置与报酬结晶"]
        PERF["performance-settlement.js v1/v2/v3 冻结结算算法"]
        POLICY["performance-fee-policy.js 费率快照与当前策略唯一定义"]
        LEDGER["settlement-ledger.js 算法版本迁移/锁定快照校验"]
        ORDER["event-order.js 确定性单调顺序键 (sequenceNumber)"]
        ERRORS["api-errors.js 类型化业务错误信封 (Input/Conflict/NotFound)"]
        STORAGE["storage.js 三文件原子写入/WAL事务日志/滚动ZIP快照"]
        YAHOO["yahoo.js Yahoo Finance 抓取 / 多源汇率降级"]
        MARKET_HIST["market-history.js 逐日行情事实库与交易日对齐"]
        CUSTOM_BENCH["custom-benchmark.js 双组合权重收益聚合与归一化"]
        BUDGET["replay-performance-budget.js 典型/上限/硬上限重放耗时预算度量"]
    end

    subgraph Data["持久化数据层 data/"]
        DB["db.json 成员/普通事件/业绩报酬配置 (核心三文件)"]
        SETTLEMENTS["settlements.json 结算/冲销审计记录 (核心三文件)"]
        CONFIG["config.json 双自定义组合与标的配置 (核心三文件)"]
        MARKET_HIST_DATA["market-history.json 核心逐日行情事实库 (只增不漏)"]
        INDEX_CACHE["index-cache.json 指数历史收盘缓存 (可从历史重建)"]
        CUSTOM_BENCH_CACHE["custom-benchmark-cache.json 自定义组合缓存 (可从历史重建)"]
        CNH_CACHE["cnh-rate-cache.json 当前汇率缓存 (独立解耦)"]
        TICKER_CACHE["ticker-cache.json 标的行情缓存 (独立解耦)"]
        MARKER[".settlements-initialized 账本初始化标记"]
    end

    subgraph DemoData["离线演示 demo/"]
        DEMO_BUILD["build-ledger.js 虚构周度账本生成"]
        DEMO_MARKET["weekly-market.json 2022年起周度固化行情快照"]
    end

    subgraph Backup["备份保护层 backups/"]
        ZIP["snapshot_backup_*.zip 三文件完整快照 滚动保留15份"]
        JOURNAL[".snapshot-transaction.json 崩溃恢复预写事务日志"]
    end

    subgraph External["外部数据源 (仅服务端调用)"]
        YAHOO_API["Yahoo Finance API 指数/自选标的/汇率日线"]
        ER_API["Open ER API / Frankfurter / Currency API 汇率降级源"]
    end

    Browser -->|HTTP JSON API| Server
    Server --> Routes
    Routes --> Lib
    CALC --> PERF
    CALC --> DISPOSAL
    CALC --> POLICY
    CALC --> ORDER
    CALC --> MARKET_HIST
    CALC --> CUSTOM_BENCH
    DISPOSAL --> PERF
    PERF --> POLICY
    LEDGER --> CALC
    LEDGER --> ORDER
    STORAGE --> MARKET_HIST
    STORAGE --> POLICY
    Routes --> ERRORS
    Lib --> Data
    R_DEMO --> DemoData
    STORAGE --> Backup
    YAHOO --> External
```

---

## 2. 事件溯源与双轨收益数据流

```mermaid
flowchart LR
    subgraph Input["事件录入 (外部驱动)"]
        D["入金 deposit"]
        W["出金 withdraw"]
        V["估值 valuation"]
        T["转让 transfer"]
        S["结算 settlement"]
    end

    subgraph EventStore["不可变事件账本"]
        ES["db.json 普通 events<br/>+ settlements.json 锁定结算 records"]
    end

    subgraph Replay["事件溯源重放引擎 (calculator.js)"]
        SORT["按日期 + sequenceNumber 严格单调排序"]
        LOOP["逐事件顺序推进"]
        DEC["Decimal.js precision:40 全程精确计算"]
        ALIGN["market-history 交易日对齐 (严格取 T 之前最近收盘价)"]
        PRINCIPAL["逐批次未退出本金追踪 (出金/转让同比例缩减)"]
    end

    subgraph State["派生全局状态 (派生并缓存)"]
        NAV["总资产 / 总份额 / 单位净值"]
        ACTIVE_ROI["在管本金收益率 (Active Capital ROI)"]
        CASH_ROI["累计现金回报率 (成立以来现金流入流出比)"]
        MEM["各成员双轨资产卡片 (USD + CNH 现值与本金)"]
        HIST["基金净值历史走势折线"]
        BENCH["标普500 / 纳指100 / 双自定义基准归一化对比"]
        LOT["LP 资金批次明细 / 门槛复利 / 高水位 (HWM)"]
    end

    D & W & V & T & S -->|新增写入；未锁定普通事件可删改并级联重放| ES
    ES -->|读取| SORT
    SORT --> LOOP --> DEC
    DEC --> ALIGN --> PRINCIPAL
    PRINCIPAL --> NAV & ACTIVE_ROI & CASH_ROI & MEM & HIST & BENCH & LOT
```

---

## 3. 数据写入与事务安全机制

```mermaid
flowchart TD
    START["API 写入请求"] --> VALIDATE["输入格式校验 + 当前/历史 GP 引用不变量"]
    VALIDATE -->|校验失败| REJECT["400 格式错误拒绝"]
    VALIDATE -->|校验通过| LEDGER_CHECK["findLedgerIssue 全账本一致性校验 (沙箱重放)"]
    LEDGER_CHECK -->|份额不足 / 业绩报酬扣减不足| REJECT_ISSUE["400 业务冲突拒绝"]
    LEDGER_CHECK -->|通过| LOCK_CHECK["结算锁账检查 (日期 <= 最近结算日)"]
    LOCK_CHECK -->|处于锁账期| REJECT_LOCK["409 锁账拒绝 (须先倒序冲销)"]
    LOCK_CHECK -->|通过| BACKUP["writeCoreBackup 创建三文件 ZIP 滚动快照"]
    BACKUP --> JOURNAL_START["写入 .snapshot-transaction.json 事务预写日志"]
    JOURNAL_START --> TEMP["prepareTempFile 写入各临时文件 + fsync 落盘"]
    TEMP --> RENAME["逐一 rename 原子替换核心文件"]
    RENAME --> JOURNAL_END["删除事务预写日志 (事务成功提交)"]
    JOURNAL_END --> CACHE_INV["清除服务端内存缓存 _stateCache = null"]
    CACHE_INV --> SUCCESS["200 操作成功返回"]

    BACKUP -->|失败| ABORT["直接中止，不改动任何核心文件"]
    TEMP -->|失败| CLEANUP["清理临时文件并抛出异常"]
    RENAME -->|中途崩溃/断电| CRASH_RECOVERY["下次服务启动自动检测事务日志，回滚旧快照"]
```

---

## 4. 业绩结算算法版本冻结体系

本系统恪守 **1956 年巴菲特合伙人基金（BPL）契约**（0% 固定管理费、6% 复利门槛、25% 提成、GP 倾囊同投）。历史算法迭代通过冻结版本确保历史审计绝对不可篡改：

```mermaid
flowchart TD
    subgraph Frozen["冻结历史算法 (只读回放，不可改写)"]
        V1["v1 成员汇总收费<br/>合并全部 LP 批次统一计算门槛与报酬"]
        V2["v2 逐批独立核算<br/>每个入金批次独立计算门槛，各批次盈亏不对冲"]
    end

    subgraph Current["当前生产算法"]
        V3["v3 高水位 (HWM) 分离与周期重启<br/>正式结算重置计费天数，每份高水位 NAV 只升不降<br/>报酬通过 LP 向 GP 划转份额兑现，不影响基金净值"]
    end

    subgraph Migration["算法迁移检测器 (settlement-ledger.js)"]
        M_READ["读取历史无版本记录"]
        M_REPLAY["分别使用 v1、v2 执行全量重放"]
        M_COMPARE["比对重放结果与历史锁定快照"]
        M_MATCH{"是否唯一精准匹配?"}
        M_ASSIGN["安全补全 algorithmVersion 标记"]
        M_REJECT["存在歧义或状态不一致，拒绝自动加载"]
    end

    NEW_SETTLE["新增结算确认"] -->|固定以当前最新版本写入| V3
    HISTORY["历史记录回放"] -->|按事件自身快照版本| V1
    HISTORY -->|按事件自身快照版本| V2
    HISTORY -->|按事件自身快照版本| V3

    M_READ --> M_REPLAY --> M_COMPARE --> M_MATCH
    M_MATCH -->|是| M_ASSIGN
    M_MATCH -->|否| M_REJECT
```

---

## 5. 三核心文件原子事务 writeSnapshot

```mermaid
sequenceDiagram
    participant API as API 业务层
    participant S as storage.js
    participant FS as 本地文件系统
    participant J as 事务日志 (.snapshot-transaction.json)

    API->>S: writeSnapshot(db, config, settlements)
    S->>S: writeCoreBackup() 生成当前状态的完整 ZIP 快照
    S->>FS: prepareTempFile(db) + fsync
    S->>FS: prepareTempFile(config) + fsync
    S->>FS: prepareTempFile(settlements) + fsync
    S->>FS: prepareTempFile(marker) + fsync

    Note over S,J: 记录旧核心文件完整镜像到事务日志
    S->>J: 写入旧数据快照并 fsync

    Note over S,FS: 逐个原子重命名替换
    S->>FS: rename(tmp_db -> db.json)
    S->>FS: rename(tmp_config -> config.json)
    S->>FS: rename(tmp_settlements -> settlements.json)
    S->>FS: rename(tmp_marker -> .settlements-initialized)

    S->>J: 删除事务日志 (确认事务提交完成)
    S-->>API: 写入成功

    Note over S,J: 异常崩溃与断电自愈分支 (Crash Recovery)
    Note over S,J: 下次系统重启执行 storage.init() 时
    S->>J: 检测是否存在未完成的 .snapshot-transaction.json
    alt 发现残留事务日志
        S->>J: 读取未完成事务中的旧数据镜像
        S->>FS: 恢复全部 4 个核心文件至旧版本
        S->>J: 清理事务日志，输出自愈回滚警报
    end
```

---

## 6. 代码模块依赖拓扑

```mermaid
graph LR
    SERVER["server.js (主入口)"] --> STORAGE["lib/storage.js"]
    SERVER --> CALC["lib/calculator.js"]
    SERVER --> SETTLE_L["lib/settlement-ledger.js"]
    SERVER --> YAHOO["lib/yahoo.js"]
    SERVER --> MARKET_H["lib/market-history.js"]
    SERVER --> R_API["routes/api.js"]
    SERVER --> R_DEMO["routes/demo.js"]

    R_API --> R_TX["routes/transactions.js"]
    R_API --> R_SET["routes/settlements.js"]
    R_API --> R_MEM["routes/members.js"]
    R_API --> R_TK["routes/tickers.js"]
    R_API --> R_STG["routes/settings.js"]
    R_API --> R_CB["routes/custom-benchmark.js"]
    R_API --> R_BK["routes/backup.js"]

    CALC --> PERF["lib/performance-settlement.js"]
    CALC --> DISPOSAL["lib/member-disposal.js"]
    CALC --> POLICY["lib/performance-fee-policy.js"]
    CALC --> ORDER["lib/event-order.js"]
    CALC --> MARKET_H
    CALC --> CB_LIB["lib/custom-benchmark.js"]

    STORAGE --> POLICY
    STORAGE --> MARKET_H
    POLICY --> ERRORS["lib/api-errors.js"]
    SETTLE_L --> CALC
    SETTLE_L --> PERF
    SETTLE_L --> ORDER
    SERVER --> ERRORS
    R_BK --> SETTLE_L
    R_BK --> POLICY
    R_BK --> ORDER
    R_SET --> PERF
    R_SET --> POLICY
    R_CB --> CB_LIB

    TEST_PERF["test/test-replay-performance.js"] --> BUDGET["lib/replay-performance-budget.js"]
    TEST_PERF --> CALC
```

---

## 7. 部署模型与安全边界约束

```mermaid
flowchart LR
    subgraph Localhost["本地安全闭环 (当前默认)"]
        BROWSER["本机浏览器 (127.0.0.1:3000)"] -->|本地无鉴权 HTTP| SERVER["Express 服务进程"]
        SERVER --> LOCAL_FS["本机 data/、backups/、demo/"]
    end

    subgraph RemoteUntrusted["非信任网络与多设备接入"]
        REMOTE["家庭局域网 (手机/iPad) / 公网"] -. 默认拒绝连接 (回环绑定) .-> SERVER
        PROXY["反向代理 / 端口转发 (严禁直接暴露)"] -->|必须先满足防御前置| HARDEN["前置安全网关"]
        HARDEN -->|身份认证 + CSRF Token + 限流| SERVER
    end
```

### 核心安全治理准则
1. **单机回环专用（Loopback-Only）**：默认且强制仅监听 `127.0.0.1`。当前系统不设用户登录与多租户权限隔离，**绝对严禁直接修改监听地址（`0.0.0.0`）或通过内网穿透/端口转发向局域网与公网暴露**。
2. **CSP 纵深防御**：全站启用严格的 Content Security Policy，彻底移除任何外部 CDN 引用（Chart.js、SortableJS、Inter/Outfit 字体均由本地提供），禁止内联脚本执行（No Inline Scripts），杜绝 XSS 与远程供应链投毒。
3. **跨设备协同前置条件（TD-003）**：若未来需满足家庭成员通过手机/平板查账的需求，必须先在架构层面实现**轻量级只读 Token / 成员口令鉴权**与 CSRF 防御机制。
