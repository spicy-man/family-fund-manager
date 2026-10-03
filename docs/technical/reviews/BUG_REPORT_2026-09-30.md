# 🐛 家庭基金账目管理系统 - 待修复缺陷与审查清单 (Bug Report)

> **归档说明**：历史缺陷记录：本轮 #1–#10 已修复，复现正文保留修复前状态。 [返回审查总表](../CODE_REVIEW.md)。

> **记录时间**：2026-09-30  
> **适用版本**：v3.16.2  
> **状态概览**：原始审查及复现记录保留如下；#1–#10 均已修复。#3 的正常流程触发条件仍以文末限定为准。

## 本轮修复状态（2026-09-30）

| 编号 | 状态 | 修复结果 |
| --- | --- | --- |
| #1 | 已修复 | 空流水提示覆盖全部 8 列 |
| #2 | 已修复 | 筛选器增加内部转让和结算冲销 |
| #3 | 已修复 | 编辑出入金及转让双方时补齐 LP 校验，拒绝非 LP 成员且不写入账本 |
| #4 | 已修复 | 空人民币金额可保存；编辑时显式清空按当前汇率换算 |
| #5 | 已修复 | 撤销卡片使用默认光标；开始真实删除时禁用撤销，并拦截迟到及重复点击 |
| #6 | 已修复 | 核心恢复成功后，汇率写入失败返回成功及明确警告，页面显示警告 |
| #7 | 已修复 | 预览响应绑定请求版本和不可变参数，丢弃过时成功及失败响应 |
| #8 | 已修复 | 默认保持历史隐含汇率，手动人民币金额不被后续美元编辑覆盖 |
| #9 | 已修复 | 普通写入、快照和导出排除行情历史；启动清理旧副本，保留独立行情文件 |
| #10 | 已修复 | 普通编辑/删除接口对结算和冲销统一返回 409 |

新增 `test/test-controller-regressions.js`，覆盖结算响应乱序、输入变化失效、过时失败响应、预览完成前确认、历史汇率、手动金额保留及恢复警告显示；扩展 HTTP 集成和存储测试，覆盖汇率缓存故障、空人民币金额、冲销不可变性及行情数据隔离。测试使用临时账本，未改写实际 `data/`。

---

## 目录
- [1. 【UI 布局错位】流水表格筛选无结果时 `colspan` 少算一列](#1-ui-布局错位流水表格筛选无结果时-colspan-少算一列)
- [2. 【功能缺失】流水类型下拉筛选框遗漏“内部转让 (Transfer)”与“结算冲销”](#2-功能缺失流水类型下拉筛选框遗漏内部转让-transfer与结算冲销)
- [3. 【权限与业务规则漏洞】编辑事件接口 `PUT /api/event/:id` 遗漏 LP 身份校验](#3-权限与业务规则漏洞编辑事件接口-put-apieventid-遗漏-lp-身份校验)
- [4. 【数值转换缺陷】编辑出入金清空人民币金额时保存报错 400](#4-数值转换缺陷编辑出入金清空人民币金额时保存报错-400)
- [5. 【交互容错隐患】删除流水 3 秒撤销通知卡片的全局点击交互优化](#5-交互容错隐患删除流水-3-秒撤销通知卡片的全局点击交互优化)

---

### 1. 【UI 布局错位】流水表格筛选无结果时 `colspan` 少算一列

* **严重级别**：次要 (UI / DOM 布局)
* **涉及文件**：[`public/js/ledger-renderer.js`](../../../public/js/ledger-renderer.js) 第 184 行
* **缺陷描述**：
  流水明细主表实际包含 **8 列**：
  1. 时间
  2. 流水明细
  3. 类型
  4. 交易/估值金额
  5. 成交净值
  6. 交易份额
  7. 总净值
  8. 操作

  在 `public/index.html` 初始占位行及展开详情行中，均正确声明了 `colspan="8"` / `colSpan = 8`；但在 `public/js/ledger-renderer.js` 筛选无匹配流水时，提示单元格硬编码为 `colspan="7"`：
  ```javascript
  if (!rendered) {
    const empty = document.createElement('tr');
    empty.className = 'empty-row';
    empty.innerHTML = '<td colspan="7" style="text-align:center;color:var(--color-text-muted);padding:40px 0;">未检索到符合过滤条件的交易记录</td>';
    ledgerTbody.appendChild(empty);
  }
  ```
* **影响**：用户通过顶部成员或流水类型过滤导致列表为空时，提示单元格宽度无法覆盖最后一列（操作列），导致表格右侧出现空白断层、网格线截断错位。
* **修复建议**：将 `colspan="7"` 改为 `colspan="8"`。

---

### 2. 【功能缺失】流水类型下拉筛选框遗漏“内部转让 (Transfer)”与“结算冲销”

* **严重级别**：中等 (功能缺失 / 操作盲区)
* **涉及文件**：[`public/index.html`](../../../public/index.html) 第 668-675 行
* **缺陷描述**：
  系统在操作面板提供四大业务操作（出入金、净值重估、内部转让、业绩结算），底层渲染器 `ledger-renderer.js` 也完整支持 `transfer`（内部转让）与 `performance_settlement_reversal`（结算冲销）的徽章与明细渲染。但在流水类型过滤下拉框 `<select id="filter-type">` 中：
  ```html
  <select id="filter-type" class="select-input">
    <option value="all">所有流水类型</option>
    <option value="deposit">入金 (Deposit)</option>
    <option value="withdraw">出金 (Withdraw)</option>
    <option value="valuation">净值重估 (Valuation)</option>
    <option value="performance_settlement">业绩结算</option>
  </select>
  ```
  缺少了 `transfer` 和 `performance_settlement_reversal` 选项。
* **影响**：用户在录入内部转让划转后，无法在流水表格中通过类型筛选只看“内部转让”记录。
* **修复建议**：在下拉框中追加对应选项：
  ```html
  <option value="transfer">内部转让 (Transfer)</option>
  <option value="performance_settlement_reversal">结算冲销</option>
  ```

---

### 3. 【权限与业务规则漏洞】编辑事件接口 `PUT /api/event/:id` 遗漏 LP 身份校验

* **严重级别**：严重 (业务契约与完整性穿透)
* **涉及文件**：[`routes/transactions.js`](../../../routes/transactions.js) 第 317-322 行 及 第 380-391 行
* **缺陷描述**：
  在新增出入金与内部转让时，系统强制要求参与者具备 LP 身份：
  - `POST /api/transaction`：`if (memberObj.roles?.lp === false) throw new InputError('只有具有LP身份的成员可以登记出入金。');`
  - `POST /api/transfer`：`if (fromObj.roles?.lp === false || toObj.roles?.lp === false) throw new InputError('普通投资份额只能在LP成员之间转让。');`

  但在修改事件接口 `PUT /api/event/:id` 中，修改出入金成员或转让双方时，仅校验了成员 ID 是否存在，**完全遗漏了 LP 身份检查**：
  ```javascript
  // 出入金修改部分
  if (member !== undefined) {
    const memberObj = db.members.find(m => m.id === member);
    if (!memberObj) {
      throw new InputError('无效的家庭成员');
    }
    // 遗漏：roles?.lp !== false 校验！
    event.member = member;
  }

  // 内部转让修改部分
  if (fromMember !== undefined) {
    const fromObj = db.members.find(m => m.id === fromMember);
    if (!fromObj) throw new InputError('无效的出让家庭成员');
    // 遗漏：roles?.lp !== false 校验！
    event.fromMember = fromMember;
  }

  if (toMember !== undefined) {
    const toObj = db.members.find(m => m.id === toMember);
    if (!toObj) throw new InputError('无效的受让家庭成员');
    // 遗漏：roles?.lp !== false 校验！
    event.toMember = toMember;
  }
  ```
* **影响**：用户或接口调用方可通过编辑已有流水将交易指派给纯 GP 成员，绕过系统业务约束，造成非 LP 成员持有份额或进行出资划转，破坏底层台账数学契约。
* **修复建议**：在 `PUT /api/event/:id` 的对应分支补充与 `POST` 相同的 LP 角色校验。

---

### 4. 【数值转换缺陷】编辑出入金清空人民币金额时保存报错 400

* **严重级别**：中等 (数据转换与容错缺陷)
* **涉及文件**：
  - 前端：[`public/js/transaction-controller.js`](../../../public/js/transaction-controller.js) 第 183 行
  - 后端：[`routes/transactions.js`](../../../routes/transactions.js) 第 44-51 行、第 330-344 行
* **缺陷描述**：
  在“编辑账目”对话框中，人民币金额输入框未加 `required`，设计上支持用户清空后让系统按汇率自动重算。
  - 前端逻辑：`payload.cnhAmount = parseFloat(editCnhAmount.value);`。当输入框为空时，`parseFloat("")` 返回 `NaN`，在 `JSON.stringify` 时被序列化为 `null` 发送。
  - 后端校验：
    ```javascript
    if (cnhAmount !== undefined) {
      const parsedCnh = toFiniteNumber(cnhAmount);
      if (!Number.isFinite(parsedCnh) || parsedCnh <= 0) {
        throw new InputError('人民币金额必须大于 0');
      }
      event.cnhAmount = parsedCnh;
    }
    ```
    由于 `null !== undefined` 为 `true`，`toFiniteNumber(null)` 解析为 `NaN`，直接抛出 `InputError('人民币金额必须大于 0')`。
* **影响**：用户在编辑出入金记录时，一旦尝试清空人民币金额以便重新按全局汇率换算，保存操作必定失败报错。
* **修复建议**：
  - 前端：仅在输入框非空且为有效数值时才挂载 `payload.cnhAmount`；
  - 后端：在 `PUT /api/event/:id` 及 `POST /api/transaction` 中，把 `null` 和空字符串均视同未传递（`undefined`），触发汇率自适应重算逻辑。

---

### 5. 【交互容错隐患】删除流水 3 秒撤销通知卡片的全局点击交互优化

* **严重级别**：轻微 (交互体验 / 防误触)
* **涉及文件**：[`public/js/app.js`](../../../public/js/app.js) 第 760-820 行、[`public/css/overlays.css`](../../../public/css/overlays.css)
* **缺陷描述**：
  v3.16.2 版本为解决操作面板被 Toast 遮挡问题，给 `.toast` 添加了 `pointer-events: auto; cursor: pointer;` 并支持点击即刻关闭。
  但在流水删除时，Toast 内部包含了一个 `<button class="toast-undo-btn">↩ 撤销</button>`。若用户本意想点击撤销按钮，但点击位置稍有偏差落在卡片其他区域，卡片样式让其产生“点击即关闭”的心理预期；同时若 3 秒计时刚好结束、异步请求已发出时，再次点击撤销已无法挽回。
* **修复建议**：
  为撤销类通知（`.toast-undo`）显式覆盖 `cursor: default;`，避免用户误将可点击卡片与操作按钮混淆，并在进入真实删除流程后将按钮明确禁用。

---

## 2026-09-30 补充审查：新增 5 项已复现问题

**验证范围**：重新运行 `npm test`，28 套测试全部通过。下面的问题另用 Node VM 执行真实前端控制器，或启动真实 HTTP 服务复现；服务通过 `FUND_DATA_DIR` / `FUND_BACKUP_DIR` 指向系统临时目录，关闭外部行情同步，未修改用户账本。业务源码未修改。

### 6. [P1] ZIP 恢复返回失败时，核心账本可能已经被覆盖

* **位置**：`routes/backup.js:290-293`；`server.js:228-234`。
* **触发条件**：核心快照提交成功后，写入汇率缓存失败，例如缓存文件权限异常或磁盘写入失败。
* **原因**：先执行 `writeSnapshot(db, importedConfig, settlementMigration.ledger)` 提交账本，再执行没有单独容错的 `writeCnhRate(...)`。后者失败直接进入 API 错误处理，前端提示“恢复失败”，核心快照却不会回滚。
* **复现证据**：隔离账本中原始入金为 $100；上传入金为 $150 的合法 ZIP，并仅对 `storage.writeCnhRateCache` 注入写入异常。API 返回 HTTP 500 / `STORAGE_ERROR`，随后读取实际 `db.json`，入金已变成 $150。
* **影响**：失败反馈与实际账本状态不一致，用户可能继续按旧账本操作或反复重试；当前人民币估值也可能仍采用旧汇率。
* **建议**：明确恢复的事务边界。若汇率是可重建缓存，提交核心账本后将缓存失败转为明确的成功附带提示；若必须一并恢复，则将汇率纳入同一事务并完整回滚。

### 7. [P1] 结算预览乱序返回会混用旧金额与新结算日期

* **位置**：`public/js/settlement-controller.js:36-37`、`:71`、`:89`。
* **触发条件**：预览 A 的请求未结束时，更改结算日期并预览 B；B 先返回，A 后返回。
* **原因**：`pendingSettlement` 是共享可变变量，预览按钮未防重复请求，也没有请求版本校验。旧响应仍可以写入预览内容，而标题和确认请求使用的是最新 `pendingSettlement`。
* **复现证据**：用真实控制器配合两条可控 Promise，先请求 03-03（报酬 $10），再请求 03-04（报酬 $20）；先完成 B，再完成 A。最终弹窗金额是 $10，标题日期是 03-04，点击确认发送的日期也是 03-04。
* **影响**：用户审核的金额与实际确认的结算不一致；后端仍会按新日期正确重算，但确认失去了预览依据。
* **建议**：请求使用不可变 payload，并通过递增请求版本丢弃过时响应；输入变化也应递增版本。确认只允许提交与当前成功展示的响应绑定的 payload。

### 8. [P2] 编辑美元金额时，历史人民币金额被当前汇率覆盖

* **位置**：`public/js/transaction-controller.js:120-125`；对照 `routes/transactions.js:331-335`。
* **触发条件**：历史出入金的汇率与当前全局汇率不同，在编辑弹窗修改美元金额并保存。
* **原因**：美元输入的 `input` 事件无条件使用 `inputCnhRate.value` 重填人民币金额，提交时又显式发送该金额；后端原本“未传人民币金额时保持原交易隐含汇率”的保护因此无法生效。
* **复现证据**：历史流水 $100 / ¥700（汇率 7），当前全局汇率 7.8；在真实控制器中把美元金额改成 $200，人民币框立即变成 ¥1,560，而保留原交易汇率应为 ¥1,400。
* **影响**：只修改美元金额也会改变历史人民币本金或提款金额，进而改变人民币收益；用户未主动修改历史换汇口径。
* **建议**：编辑时默认保留原流水隐含汇率，并尊重手动人民币金额；使用当前汇率应是明确操作。新增交易的自动换算可保持现有行为。

### 9. [P2] 行情历史被重复写入核心账本及自动备份

* **位置**：`server.js:123`、`:181-185`；`lib/storage.js:137-141`。
* **原因**：服务读取时把外部行情库挂在 `db.marketHistory` 上，但持久化过滤函数只删除 `indexCache` 与 `customBenchmarkCache`，没有删除 `marketHistory`。普通交易写入会把整个行情库再次存入 `db.json`；自动 ZIP 备份也携带这份副本。
* **复现证据**：全新隔离账本完成一次合法入金后，直接读取磁盘 `db.json`，发现新增 `marketHistory: { version: 1, updatedAt: null, tickers: {} }`。行情库非空时，同一赋值路径会保存其完整内容。
* **影响**：账本、每次写入和滚动备份随行情历史增长；手动导出也会携带该字段，可能挤占恢复接口 10MB 的解压数据限额。行情缓存与核心账本解耦的约定没有完整实现。
* **建议**：所有核心持久化及导出路径统一移除 `marketHistory`，读取时继续从独立文件加载；清理已有冗余字段时保留独立行情文件。

### 10. [P2] 冲销记录的编辑/删除 API 返回成功，实际未保存

* **位置**：`routes/transactions.js:257`、`:287`；`server.js:181-185`。
* **触发条件**：直接请求 `PUT /api/event/:id` 或 `DELETE /api/event/:id`，目标为 `performance_settlement_reversal`。页面已经隐藏这类操作按钮，问题发生在 API 层。
* **原因**：接口只禁止 `performance_settlement`，未禁止冲销记录；但 `writeDb` 会过滤所有结算及冲销事件，只写普通账本，根本不会修改独立 `settlements.json`。PUT 还没有冲销类型的更新分支。
* **复现证据**：真实 HTTP 服务中完成结算并冲销后，删除该冲销记录返回 HTTP 200 / `success: true`；紧接着 `GET /api/state`，同一冲销 ID 仍然存在。
* **影响**：接口谎报操作成功，调用方无法可靠判断审计记录是否发生变更。当前没有实际删掉审计记录，也没有重新激活已冲销的结算。
* **建议**：普通事件编辑/删除接口同时拒绝结算和冲销类型，返回冲突错误；审计记录继续通过专用接口追加。

### 对原第 3 项的限定

原清单指出编辑接口缺少 LP 校验，这一代码差异确实存在；但目前 `POST /api/members`、成员修改、备份导入和启动迁移均将成员设为 `lp: true`，正常产品流程无法创建“纯 GP / 非 LP”成员。因此应把第 3 项标为**条件性校验缺口**：只有绕过当前成员约束构造 `lp: false` 数据时才触发，不能与上面已复现的正常流程问题同等认定。
