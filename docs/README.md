# 项目知识库与文档中心 (Documentation Hub)

家庭基金账目管理系统的所有规范、架构设计、财务治理逻辑与项目规划文档均归档于此。

---

## 目录结构索引

```text
├── CHANGELOG.md      # 📋 版本演进与特性变更日志（根目录）
├── COMMIT_GUIDE.md   # 🔍 Git 提交规范与发版指南（根目录）
├── 数据迁移说明.md   # 🗄 数据库结构与冷迁移操作指南（根目录）
└── docs/
    ├── finance/      # ⚖️ 财务逻辑、收益率分析与合伙治理契约
    ├── technical/    # 🏛 系统分层架构、代码审查与技术债务
    ├── project/      # 📌 项目开发规划与待办看板
    └── README.md     # 📖 本文档中心索引
```

---

## 1. 财务与治理 (`docs/finance/`)

专注于合伙人之间的分配机制、收益率算法模型、以及 GP/LP 权利义务确权：

| 文档 | 说明 |
| :--- | :--- |
| [基金管理准则.md](./finance/基金管理准则.md) | **核心合伙公约**：10 项治理准则、巴菲特 BPL 哲学渊源与计算案例（附 [矢量归档](./finance/fund-governance-principles.svg)） |
| [财务逻辑与治理规则审查备忘录.md](./finance/财务逻辑与治理规则审查备忘录.md) | **内审确权底稿**：GP/LP 4 项核心免检争议项论证、会计分账与审查备忘 |
| [收益率计算与退出机制分析.md](./finance/收益率计算与退出机制分析.md) | **算法模型分析**：累计现金回报率 vs 在管本金收益率（Active ROI）深度推导 |

---

## 2. 技术与架构 (`docs/technical/`)

专注于系统底层软件工程实现、事件溯源模型、代码质量与系统设计：

| 文档 | 说明 |
| :--- | :--- |
| [ARCHITECTURE.md](./technical/ARCHITECTURE.md) | **分层架构**：事件溯源重放引擎、状态机、双轨无滑点守恒与数据流向 |
| [CODE_REVIEW.md](./technical/CODE_REVIEW.md) | **架构审查**：系统核心模块评分、架构健壮度与代码质量评估报告 |
| [TECHNICAL_DEBT.md](./technical/TECHNICAL_DEBT.md) | **技术债务**：当前系统的已知债务追踪与长期重构演进清单 |
| [数据迁移说明.md](../数据迁移说明.md) | **运维操作**：底层数据结构规范、冷热备份与版本迁移操作指引（根目录） |

---

## 3. 项目与规范 (`docs/project/` & 根目录)

专注于软件版本迭代、任务看板与协作开发准则：

| 文档 | 存储位置 | 说明 |
| :--- | :--- | :--- |
| [CHANGELOG.md](../CHANGELOG.md) | 根目录 | **变更日志**：系统从 v1.0.0 到当前版本的完整技术特性发布记录 |
| [COMMIT_GUIDE.md](../COMMIT_GUIDE.md) | 根目录 | **工程规范**：Git 提交信息格式、Semantic Versioning 与发版标准流程 |
| [TASKS.md](./project/TASKS.md) | `docs/project/` | **任务看板**：待办事项、功能排期与演进路线图 |
