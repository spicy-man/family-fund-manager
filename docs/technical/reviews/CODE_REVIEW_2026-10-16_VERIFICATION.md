# 深度复核与修复验收审查报告（2026-10-16）

> **修复补记（v4.7.4，2026-10-16）**：下文保留复核时的发现。P1 已通过隔离 `pending_backup`、成功提交后确认及失败清理修复；补充连续失败后成功、清理失败、确认失败及有效备份内容的回归断言。P2 已统一单条与批量成员接口及编辑界面的六位数字、首位非零规则，并补充拒绝非法编号且不落盘的测试。原文关于非法编号“后续拒绝加载”的后果尚无充分代码证据；已确认的问题是编号规则不一致。

> **审查时间**：2026-10-16 16:05 (UTC+8)  
> **审查对象**：工作区全量未提交改动（覆盖 50 个修改文件及新增测试套件，对应 `CODE_REVIEW_2026-10-16.md` 与 `DUAL_REVIEW_2026-10-16.md`）  
> **审查基准**：全量单元与集成测试（57 个测试文件全部通过，耗时约 45s）及源码逐行比对  

---

## 总体复核结论

本次工作区的改动规模可观（+690 / -192），**确实真实闭环了首轮审查报告中提出的大部分核心缺陷**，包括金融计算偏差、多账本配置污染、前端延迟删除状态撕裂、移动端布局屏蔽等关键问题，并补充了有价值的并发与离线回归测试。

**然而，在复核过程中捕获到 1 处严重的“逻辑伪闭环”（测试通过但实际仍存在数据丢失风险）以及 1 处接口数据校验断层：**

1. **【P1 伪闭环】`lib/storage.js` 备份淘汰机制仍存在“失败写入残留挤占有效恢复点”漏洞**：虽然改动将裁剪旧备份移到了提交成功后的 `finishBackup()`，但写入失败时未清理磁盘上的候选备份，导致在经历连续失败后一旦有一次写入成功，**历史所有已确认的真实恢复点会被此前未提交的失败候选备份全部挤掉**（测试通过仅仅是因为测试断言只检查了文件总数，未验证留下的是否为有效备份）。
2. **【P2 校验断层】`routes/members.js` 6 位成员编号正则前后端不一致**：路由层依然使用允许首位为 0 的 `/^[0-9]{6}$/`，与底层领域规范 `/^[1-9][0-9]{5}$/` 冲突。

---

## 一、 证实已真实闭环的修复清单

以下 15 项核心问题经代码审计与单测执行，确认已得到正确解决且未引入次生回归：

| 编号 | 模块 | 问题与修复验证 | 关键文件 |
| :--- | :--- | :--- | :--- |
| **D-1** | 核心计算 | **GP 内部转让业绩报酬留存**：严格区分外部出金与内部转让，转让时结晶报酬正确沉淀在 GP `carryShares`，受让方仅获得净份额。补齐了 GP 混合历史 Carry 全额转让测试。 | `lib/member-disposal.js`<br>`test/test-performance-settlement.js` |
| **D-2** | 核心计算 | **编号迁移承接结算迁移**：`renameMemberIdentifiers` 已接收并使用 `migrateSettlementLedger` 返回的克隆对象，防止未打版本号的历史结算被直接重放而抛错。 | `lib/member-identifiers.js`<br>`test/test-member-identifiers.js` |
| **D-3** | 核心计算 | **旧版处置 0 份额批次崩溃修复**：`settlePerformanceV1` 将 0 份额批次显式设为 `entryNav: null` 以对齐历史 JSON 序列化；`lib/calculator.js` 在输出 `lpLedger` 和统计活跃批次时过滤 0 份额批次；`backup-import.js` 放行合法的历史空批次。 | `lib/calculator.js`<br>`lib/performance-settlement.js`<br>`lib/backup-import.js` |
| **D-5** | 核心计算 | **出金/转让截断等比缩放**：非全额出资受限截断时，统一在最终确定 `actualAmount` 后对 `eventCnhAmount` 等比缩放；补齐了纯 Carry 份额提现时 `lpSharesBefore === 0` 的零分母保护。 | `lib/member-disposal.js`<br>`lib/calculator.js` |
| **D-6** | 全盘总览 | **合并总览成员首次活跃排序**：移除了 `event.lpMembers` 空户对首次出资排序的干扰；跨账本同日事件改用底层标准的 `compareEvents` 稳定排序。 | `lib/combined-overview.js`<br>`public/js/member-renderer.js` |
| **B-1** | 备份恢复 | **副账本隔离全局共享缓存**：副账本导入备份时明确打上 `restoreSharedSettings: false`，仅恢复本账本私有数据；主账本恢复导入 `indexCache` 时补充了严格的日期与正数价格类型校验，并按日期合并写入。 | `routes/backup.js`<br>`lib/ledgers.js`<br>`demo/browser/sandbox.js` |
| **B-2** | 并发同步 | **启动汇率与基准同步覆盖竞态**：`syncBenchmarkHistory` 在网络请求完成后重新读取最新的行情与配置；启动汇率写入前检查缓存是否已被用户更新。 | `server.js` |
| **B-4** | 服务端 | **批量成员更新前置迁移**：`PUT /api/members` 在读取底表前先调用 `readDb()`，确保旧版内嵌结算拆分迁移已完成。 | `routes/members.js` |
| **B-5** | 安全策略 | **本地策略放行浏览器顶层导航**：`localRequestPolicy` 补充放行了来自外部文档直接点击打开的顶层导航请求（`sec-fetch-mode: navigate`），并支持 HTTPS 443 默认端口。 | `lib/local-request-policy.js` |
| **F-1** | 前端交互 | **3 秒撤销软删除竞态消除**：引入 `pendingDeletes` 状态机；表格重绘时持续高亮待删状态；点击撤销动态寻找当前 DOM 行恢复；发起任何写操作、试算或切账本前强制 `flushPending()`。 | `public/js/ledger-actions-controller.js`<br>`public/js/api.js`<br>`test/test-review-frontend-races.js` |
| **F-2** | 响应式 UI | **窄屏（<=1180px）侧栏入口恢复**：将侧栏改为顶部内联卡片条，保留成员设置、数据备份和管理准则的访问入口。 | `public/css/responsive-members.css` |
| **F-3** | 前端交互 | **表单校验与并发序号保护**：转让回显汇率改为 `step="any"`，彻底解决 HTML5 `stepMismatch` 阻断提交问题；`loadAllData()` 增加请求序号丢弃过期响应；自定义基准弹窗互斥防写错槽位。 | `public/index.html`<br>`public/js/app.js`<br>`public/js/custom-benchmark-controller.js` |
| **T-1** | 启动脚本 | **UNC 路径映射修正**：移除在所有盘符盲扫 `family-fund-manager` 根目录的逻辑，改用 `pushd "%~dp0"` 锁定当前执行目录。 | `start.bat` |
| **T-2** | 测试套件 | **Yahoo 汇率测试离线 Mock**：在单元测试中注入虚拟 transport，完整验证 4 级降级解析，不再发起任何真实外网请求。 | `test/test-yahoo.js` |
| **T-3** | 演示沙盒 | **Demo 基准选择与沙盒错误码**：Demo 基准接口已识别当前选中的账本；沙盒跨账本生成成员 ID 增加了防重保护，且保留真实的 HTTP 状态码与异常类型。 | `routes/demo.js`<br>`demo/browser/sandbox.js` |

---

## 二、 重点核查发现：伪闭环与隐患证据

### 1. 【P1 级别缺陷】`lib/storage.js` 连续失败写入产生的残留文件，在后续成功时会挤掉全部真实恢复点

#### 缺陷机制深入剖析
在 `lib/storage.js` 中：
```javascript
// lib/storage.js: writeDb / writeConfig / writeSettlements / writeSnapshot
const finishBackup = writeCoreBackup(nextContent, ...); // ① 立即落盘了 snapshot_backup_${timestamp}_${seq}.zip
atomicWriteFile(DB_FILE, nextContent);                  // ② 若此步抛出异常（例如杀毒软件占用、权限问题、磁盘故障）
finishBackup();                                         // ③ 异常导致 finishBackup 被跳过
```
在 `writeCoreBackup` 中：
```javascript
function writeCoreBackup(...) {
  ...
  atomicWriteFile(backupFile, zip.toBuffer()); // 写入临时候选备份文件到 BACKUP_DIR
  return () => {
    ...
    // 只有在成功提交后才执行淘汰：
    const backupFiles = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('snapshot_backup_') && f.endsWith('.zip'))
      .sort().reverse();
    backupFiles.slice(15).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  };
}
```

#### 破坏场景与后果
1. 假设系统原有 1 个确认有效的历史备份 `snapshot_backup_0001.zip`。
2. 此时因为文件占用等外部原因，`atomicWriteFile` 遭遇了连续 16 次写入失败。虽然每次 `finishBackup()` 都没触发，但 `writeCoreBackup` 已经在 `BACKUP_DIR` 留下了 16 个未提交的废弃候选包（`snapshot_backup_0002.zip` ~ `0017.zip`）。
3. 随后，第 17 次写入外部环境恢复，正常写入成功并调用了 `finishBackup()`。
4. `finishBackup()` 执行 `backupFiles.slice(15)`：由于按时间戳倒序，它保留了最新落盘的 15 个文件（即第 17 次的成功备份 + **14 个失败未提交的坏备份**），而把最初确认有效的 `snapshot_backup_0001.zip` **直接删除了**！

#### 测试漏洞证据（测试如何“掩耳盗铃”）
查看 [`test/test-storage.js:526-557`](file:///g:/code/family-fund-manager/test/test-storage.js#L526-L557)：
```javascript
// 循环 16 次失败
for (let attempt = 0; attempt < 16; attempt++) assert.throws(write, ...);
// 这里测试在失败期间断言了 confirmedBackup 还在：
assert(fs.existsSync(path.join(retainedStorage.BACKUP_DIR, confirmedBackup))); // 这一步确实还在！

// 然后测试执行了一次成功的写入：
retainedStorage.writeDb(retainedDb);
// 测试紧接着只断言了文件数量等于 15：
assert.strictEqual(fs.readdirSync(...).filter(...).length, 15);
// ❌ 测试根本没有去检查 confirmedBackup 是否还在！
// 实际上此时 confirmedBackup 已经被 slice(15) 删掉了！
```

#### 建议修复方案
- **方案 A（最稳健）**：在 `writeCoreBackup` 时将未提交的备份命名为 `pending_backup_${timestamp}_${seq}.zip`；当主文件提交成功后，在 `finishBackup()` 中将其重命名为 `snapshot_backup_...`，最后再执行旧文件裁剪；在各 write 函数的 `catch` 块中立即清理本次的 `pending_backup` 文件。
- **方案 B（轻量）**：若写入失败，在 `writeDb / writeConfig / writeSettlements / writeSnapshot` 的 `catch` 块中显式执行 `fs.unlinkSync(backupFile)`。

---

### 2. 【P2 级别缺陷】`routes/members.js` 成员编号正则未对齐底层，允许以 `0` 开头的 6 位编号

- **位置**：[`routes/members.js:71`](file:///g:/code/family-fund-manager/routes/members.js#L71) 与 [`routes/members.js:113`](file:///g:/code/family-fund-manager/routes/members.js#L113)
- **事实对比**：
  - 路由层校验：`!/^[0-9]{6}$/.test(id)`（允许 `000000`、`012345`）
  - 底层领域规范：[`lib/member-id.js:5`](file:///g:/code/family-fund-manager/lib/member-id.js#L5) 与 [`lib/member-identifiers.js:6`](file:///g:/code/family-fund-manager/lib/member-identifiers.js#L6) 显式定义并强制校验 `MEMBER_ID_REGEX = /^[1-9][0-9]{5}$/`（首位不能为 0）。
- **后果**：
  若用户通过 API 修改成员编号为 `012345`，路由层通过并写入数据库。后续系统进行标识符重映射或迁移校验时，会被底层的 `MEMBER_ID_REGEX` 判定为非法编号而拒绝加载。
- **修复方案**：将 `routes/members.js` 中的正则统一改为 `/^[1-9][0-9]{5}$/`。

---

## 三、 对 `DUAL_REVIEW_2026-10-16.md` 豁免项的复核评价

复核确认了 `DUAL_REVIEW_2026-10-16.md` 中列出的 5 项“未作为缺陷改动的事项”，其工程决策具有充分合理性：

1. **损坏账本拒绝生成新成员编号**：若某副账本 `db.json` 损坏，生成新 ID 时无法获知已有集合，此时保守报错能彻底杜绝 ID 碰撞风险。
2. **未知所有者的空锁目录拒绝自动抢占**：在 NAS 多机或异常掉电场景下，避免不同主机错误接管仍在运行的实例目录。
3. **空账本收益率保持 `null`**：无出资时的收益率在数学上属于 $0/0$（无定义），系统现有单测和前端图表均依赖 `null` 语义。
4. **`settlePerformanceV3` 1-ULP 差异不改**：合批判断若轻率引入容差，会破坏历史已落盘快照的散列或比对一致性。
5. **部分内部变量拼入 HTML 未加转义**：受校验白名单保护的 ID 和系统生成的合法日期无 XSS 注入通道，未过度封装。

---

## 四、 总结与建议行动项

| 发现项 | 严重级别 | 现状评估 | 处置建议 |
| :--- | :--- | :--- | :--- |
| **已验证的 15 项修复** | 正常 | 修复完整，单测覆盖充分，未见回归 | 予以认可并保留 |
| **`lib/storage.js` 候选备份残留** | **P1（高危）** | 伪闭环，单测断言有盲区，存在真实丢备份风险 | **必须返工**：引入 `pending_backup` 或在写入失败 `catch` 中清理候选 zip |
| **`routes/members.js` 正则断层** | **P2（中危）** | 遗漏未修，首位为 0 编号会导致底层验证失败 | 将正则同步改为 `/^[1-9][0-9]{5}$/` |
| **`routes/tickers.js` 标的无上限** | P3（低危） | 暂未限制数组长度 | 后续版本补上 `tickers.length <= 50` 约束 |
