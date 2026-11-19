# AGENTS.md

> 本文件分为两部分：**第一部分（通用规范）**可直接复制到任意新项目、无需修改；**第二部分（本项目配置）**仅记录当前项目的命令、版本与发布规则。新项目接入时，只需复制本文件并改写第二部分。

---

## 第一部分：通用协作与发版规范（跨项目复用）

### 1. 工作原则与修改边界

- **用户明确要求优先**：严格按当前指令及会话内仍有效的授权执行，不擅自扩大范围。
- **最小改动**：只改完成任务所需的内容，保留已有及无关修改；不顺带重构、升级依赖或整理全项目。
- **先核实再动手**：按需读取相关代码、配置和文档，核实真实技术栈、命令和业务约束；不猜测，也不为小改动遍读全仓库。
- **先判断与方案，再修改**：
  - 用户提问、反馈异常、表达疑虑或要求 review 时，**默认只读分析，不自动改代码**。
  - 先核实问题是否成立，说明依据与不确定性；有不同意见直接说，不一味附和。
  - 给出推荐方案、理由及影响（必要时对比备选），等用户明确说“直接修 / 按这个改”后再执行修改。
  - 一旦执行范围已明确授权，就持续完成必要改动与验证，不再反复确认已定事项。

### 2. 操作范围：按需执行

“按规范做”指遵守本文件约束，不表示把提交、推送、发版全跑一遍。

| 用户要求 | 默认执行范围 | 不自动追加 |
| :--- | :--- | :--- |
| 开发 / 修复 / 修改 | 代码改动 + 必要验证 | commit、push、tag、deploy、升版本 |
| `commit` / 提交 | 核对差异、按风险验证、选择授权文件并本地提交 | push、tag、deploy、升版本 |
| `push` / 推送 | 推送约定分支或指定引用 | 新建提交、打/推标签、手动部署 |
| `tag` / 打标签 | **完整发版联动**：版本准备、发布验证、必要发版提交与推送、建并推标签、创建 Release、部署与核验 | 无关改动；用户明确限制的环节（如“仅本地 tag”“不部署”） |
| `push tag` / 推送标签 | 仅推送指定已有标签 | 推其他标签/分支、新建 Release |
| `deploy` / 部署 | 构建并部署确定代码或产物、核验线上结果 | 无关提交、打标签、新建 Release |
| 完整发版 / 发布新版本 | 版本准备、发布验证、发版提交、建并推标签、Release、部署与核验 | 无关改动；用户明确限制的环节 |

- 多项指令可组合，按真实依赖排序；缺少关键目标信息时先完成可独立推进的部分，再只问缺的那项。
- **推送或打标前先核实 CI/CD 自动触发条件**：若推送分支或标签会自动部署，提前告知；用户明确禁止的结果不能通过自动化间接触发。
- 引用本文件本身不构成提交、推送、打标签或部署授权。

### 3. 按风险做最小充分验证

按改动风险选最小充分验证集，同一批修改完成后集中验证，不每改一行就跑全套测试。

| 改动类型 | 默认验证 |
| :--- | :--- |
| 文档、注释、纯文案 | 核对差异、链接与引用，不跑应用测试或构建 |
| 样式、布局 | 检查受影响页面与必要交互，不跑无关业务测试 |
| 局部功能、单个函数 | 跑直接相关的单元测试或定向检查 |
| 金额、权限、日期、数据写入、核心计算 | 验证边界、异常与回归；缺陷修复优先补回归测试 |
| 共享核心模块 / 跨模块大改 | 按调用面扩大验证；有广泛回归风险时跑全套测试 |
| 正式发版 | 执行第二部分定义的发布验证 |

- 已通过且未再被修改影响的检查不重复跑；风险覆盖即停止扩展，扩大到全套测试/构建前简短说明原因。
- 不为低风险改动写只复述实现的无意义测试；区分本次引入的失败与既有失败，不顺带修无关问题。
- 汇报只留验证结论与必要错误摘要，**未运行的检查绝不声称通过**。

### 4. 双人独立 Review（问题分析与代码审查）

- **触发条件**：用户提出涉及项目代码、行为或设计的问题/异常/疑虑，或明确要求执行 review、代码审查、查 bug。普通开发、提交、发版、编辑规则文档或一般问答**不触发**。
- **默认只读**：启动两个独立 subagent，各自独立读取并审查**完整约定范围**（不拆成两半、不先交换结论、审查前**不预读**既有问题/技术债台账，避免先入为主）。主 agent 汇总核实两方结论后报告发现、依据、分歧与方案，**不自动修改**。
- **发现标准**：需给出位置、触发条件、实际影响与依据；不把个人风格偏好当 bug，排除疑似问题时记录依据。
- **修复闭环（仅用户明确授权修复后进入）**：
  1. 主 agent 修复有效发现并完成必要定向验证；
  2. 两名审查者分别基于最新代码重新独立复审（可复用 subagent，但不能沿用上一轮通过状态）；
  3. 循环至同一份最终代码两方均无未解决的有效发现、必要验证通过且无未处理争议为止。
- 不预设轮数提前结束，达标后也不追加无意义轮次；工具或环境受阻时如实报告，**严禁用主 agent 自审冒充独立审查通过**。
- 最终报告审查范围、轮数、修复、验证及剩余限制；表述为“本轮未发现未解决问题”，不承诺绝对零 bug。

### 5. 版本、提交与数据安全

- **版本**：普通提交不升版本；正式发版采用 `MAJOR.MINOR.PATCH`（不兼容升主、新能力升次、修复/优化升修订）。坚持唯一版本来源，不复用已发布版本号，不覆盖或强推已有标签。
- **提交**：先查分支与工作区，逐项暂存本次授权文件，绝不提交凭据、临时验证材料或无关产物。普通提交用清晰中文标题；发版提交用 `v{VERSION} 简要标题`（不加句号），空一行后写平级要点列表。
- **数据与变更保护**：验证优先使用隔离目录与临时数据，不覆盖真实数据或生产配置；尊重项目已有的校验、文件锁、原子写入与迁移保护；未获明确授权绝不丢弃修改、改写历史或强制推送。

### 6. 完成汇报标准

简明说明改了什么、实际验证了什么、还有什么未完成或限制项。严格区分：
- **本地提交** ≠ **远端推送**；
- **本地标签** ≠ **远端标签**；
- **构建成功** ≠ **部署成功**（部署以流水线结果和必要线上核验为准）。

---

## 第二部分：本项目配置（家庭基金账目管理系统 / Family Fund）

> 新项目复用本文件时，只需替换以下内容。

### 常用命令

```sh
npm start                            # 启动本地服务（默认 http://127.0.0.1:3000，通过 PORT 改端口）
npm test                             # 运行全量隔离回归测试（node scripts/run-tests.js）
node test/test-version.js            # 仅运行版本号一致性校验
node scripts/release-notes.js vX.Y.Z # 预检标签名、版本匹配与 CHANGELOG 发布说明提取
npm run demo:build                   # 构建静态可操作沙盒到 dist-demo/
npm run demo:refresh                 # 刷新离线 Demo 周度行情快照（可传截止周五，如 -- 2026-10-02）
bash 一键打包.command --no-pause      # 本地生成离线发布包 family-fund-manager_v{VERSION}.zip
```

### 5 步发版速查 Checklist

1. **同步 4 处版本号**：同步更新 `package.json`、`package-lock.json`（顶层与 `packages[""]`）、`public/index.html`（`.sidebar-version`）及 `CHANGELOG.md` 顶部版本声明。
2. **写更新日志**：在 `CHANGELOG.md` 顶部声明下方、上一版本之前新增条目（格式见下文），确保至少有一条 `- ` 列表项。
3. **发布前验证**：运行 `npm test`（含版本一致性与发布说明测试）、`node scripts/release-notes.js v{VERSION}`、`npm run demo:build` 与 `git diff --check`；若涉及页面或交互改动，使用隔离数据目录起服或预览 `dist-demo/` 核验关键交互。
4. **提交并推送主干**：逐项暂存本次发版改动 → 按 `v{VERSION} 简要标题` 格式提交 → 推送 `main` → 跟进 `.github/workflows/demo-pages.yml` 自动部署在线沙盒。
5. **打标自动发版与核验**：创建并推送 `v{VERSION}` 标签 → 跟进 `.github/workflows/release.yml` 自动打包离线 ZIP 并发布 GitHub Release（**不要手动执行 `gh release create`**）→ 核验 GitHub Pages 在线沙盒版本徽标/核心功能，以及 Release 附件 `family-fund-manager_v{VERSION}.zip` 与更新说明。

### 版本、文件与数据安全约定

- **唯一版本来源**：`package.json` 的 `version`。
- **版本号同步清单**（由 [test/test-version.js](test/test-version.js) 强校验，禁止跳过）：
  - `package.json`：`"version"`
  - `package-lock.json`：顶层 `"version"` 与 `packages[""].version`
  - `public/index.html`：侧边栏徽标 `.sidebar-version`（`v{VERSION}`）
  - `CHANGELOG.md`：顶部版本声明与新增版本条目标题
- **`CHANGELOG.md` 必填格式**（[test/test-version.js](test/test-version.js) 与 [scripts/release-notes.js](scripts/release-notes.js) 强校验）：
  - 顶部声明：`目前系统版本为 **v{VERSION}** (更新日期: {YYYY-MM-DD})。`
  - 最新标题：`## ✨ v{VERSION} 简要标题 [NEW]`（修复/优化用 `🔧 / [FIX]`，破坏性变更用 `💥 / [BREAKING]`）；正文用 `- ` 列表写用户可感知的变化，不堆砌内部符号清单。
- **不入库文件**：`data/*`（保留 `data/.gitkeep`）、`backups/`、`dist-demo/`、`dist/`、`*.zip`（含本地打包生成的 `family-fund-manager_v*.zip`）、`.env*`、`.agents/`、`.codex/`、凭据及临时验证文件。
- **真实账本与锁保护**：
  - `data/` 与 `backups/` 可能存放真实账本；严禁在测试或验证中读写正式数据目录。
  - `npm test` 自动使用临时目录并关闭外部同步；单独运行涉及存储或接口的测试脚本，或手动起服验证时，**必须显式设置临时 `FUND_DATA_DIR`、`FUND_BACKUP_DIR` 与 `FUND_EXTERNAL_SYNC=0`**。
  - 尊重 `.fund-manager.lock/` 单实例独占锁与 `.snapshot-transaction.json` 事务恢复机制，不在服务运行中手工编辑 `data/` 或随意删除锁/事务文件。

### 分支、CI、定向验证与台账约定

- **双工作流自动触发**：
  - `main` 是唯一主分支；推送 `main` 自动触发 `.github/workflows/demo-pages.yml`（`npm ci` → `npm test` → `npm run demo:build` → 部署在线沙盒到 GitHub Pages）。
  - 推送 `v*` 标签自动触发 `.github/workflows/release.yml`（校验标签与 `CHANGELOG.md` → `npm ci` → `npm test` → `npm prune --omit=dev` → macOS 一键打包离线 ZIP → 自动创建并公开 GitHub Release；含 `-` 的标签自动标记为预发布）。
- **纯文档免部署**：用户明确本次只改文档不更新在线沙盒时，提交说明可加 `[skip ci]`。
- **线上/发版恢复**：
  - 在线沙盒部署失败：从 `main` 手动触发 `Deploy interactive Demo to GitHub Pages` 的 **Run workflow**，不重跑旧工作流定义。
  - Release 发布失败：先检查 GitHub Releases 是否留有草稿（draft）并清理后再处理；已公开的同版本 Release 不会被覆盖，禁止强推或复用已发布标签。
- **关键领域定向验证**：
  - 财务计算与历史回放（`decimal.js`、业绩报酬高水位、历史事件费率快照与 `disposalVersion`）不得因重构改变既有结果；优先运行对应计算、结算、出金/转让、备份恢复与多账本测试。
  - 本机安全边界：保持默认仅监听 `127.0.0.1`、保留 [lib/local-request-policy.js](lib/local-request-policy.js)（Host / Origin / Fetch Metadata 校验）与严格 CSP（无外链 CDN、无内联脚本），变更后校验 `test/test-security-policy.js`。
  - 静态沙盒与演示：改动前端资源、共享计算/存储逻辑或刷新 Demo 行情后，需验证 `npm run demo:build` 与 `test/test-static-demo.js` / `test/test-demo-sandbox.js`。
- **双人审查避读台账**：审查者审查前不预读 [docs/technical/CODE_REVIEW.md](docs/technical/CODE_REVIEW.md)、`docs/technical/reviews/` 下的历史审查文档与 [docs/project/TASKS.md](docs/project/TASKS.md)；主 agent 在汇总核实或修复闭环后再按需更新总表并在 `docs/technical/reviews/` 归档。
