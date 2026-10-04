# 家庭基金账目管理系统

[**在线预览 · 可操作沙盒**](https://spicy-man.github.io/family-fund-manager/) · [源码](https://github.com/spicy-man/family-fund-manager)

面向家庭和小型合伙基金的本地账本。系统按时间重放入金、出金、估值、成员转让和业绩结算事件，计算基金净值、成员份额及 LP/GP 权益。

默认仅监听 `127.0.0.1`，数据保存在本机。页面与 API 只接受本机地址和实际监听端口，请通过 `http://localhost:端口` 或 `http://127.0.0.1:端口` 访问；拒绝外部 Origin、跨站请求和异常 Host。无 Origin 的本机命令行请求仍可使用。项目没有登录和远程访问功能，不要直接暴露到公网。

## 主要功能

- 美元账本，记录人民币实付金额及汇率
- 成员、LP 份额和唯一 GP 管理
- 入金、出金、基金估值和成员间份额转让
- 基金净值、成员权益、收益走势及流水查询
- 标普 500、纳斯达克 100、两个可独立配置的单标的/百分比组合业绩对比，以及自选标的行情
- 按资金批次计算业绩报酬，支持预览、锁账和倒序冲销
- 自动 ZIP 快照，以及完整数据的导出、校验和恢复

## 快速开始

需要先安装 [Node.js](https://nodejs.org/) 和 npm。

### 快捷启动

- Windows：双击 `start.bat`
- macOS：首次执行 `chmod +x start.command`，之后双击 `start.command`

启动脚本会在缺少依赖时运行 `npm install`，并打开 <http://localhost:3000>。

### 命令行启动

```bash
npm install
npm start
```

浏览器访问 <http://localhost:3000>。停止服务时在终端按 `Ctrl+C`。

全新安装或账本尚无任何流水时，首页会显示功能欢迎页，可选择进入只读 Demo，或开始配置成员并建立正式账本。

![空账本首次使用引导](preview/welcome.png)

### 只读 Demo

启动服务后访问 <http://localhost:3000/demo>，可以浏览从 2022 年开始的周度样例账本、成员权益、业绩走势和流水记录。对标组合 1 为 AAPL 30% + GOOGL 30% + VGT 40%，组合 2 为 VGT 100%；历史行情与汇率快照来自 Yahoo Finance 并固化在项目内。Demo 使用独立数据且禁止写入，不会修改 `data/` 中的正式账本；录入面板保留用于界面预览，但全部表单与提交操作均已锁定。

![只读 Demo 数据看板](preview/demo.png)

需要把离线 Demo 快照更新到最新一周时，运行 `npm run demo:refresh`。

如需更换端口：

```powershell
# PowerShell
$env:PORT=3001; npm start
```

```bash
# macOS / Linux
PORT=3001 npm start
```

### GitHub Pages 在线预览

在线预览为可操作沙盒，支持成员管理、入金出金、估值、转让、账目修改删除、结算预览确认与冲销，以及 ZIP 备份导出恢复。成员为 John Titor、Alice Liddell、Sherlock Holmes 等虚构角色。

所有业务规则复用本地完整版，体验数据仅保存在当前标签页的 sessionStorage 中，刷新后仍保留，随浏览器会话保存，不同访客互不影响；顶部“重置样例”可恢复初始账本。数据不会上传到 GitHub，也不读取本地 `data/` 或 `backups/`。请用虚构数据体验。

行情及汇率来自项目内的离线快照，业绩对比组合可配置 AAPL、GOOGL、VGT 及其权重；标的回调追踪的刷新、配置按钮在体验版禁用，不获取实时行情。其他标的与实时联网同步请使用本地完整版。

本地构建：

```bash
npm ci
npm run demo:build
```

输出目录为 `dist-demo/`（已加入 Git 忽略规则），可通过任意静态 HTTP 服务预览。正式本地程序仍使用 `npm start`。

首次部署时，在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。此后推送到 `main`，或手动运行 **Deploy interactive Demo to GitHub Pages** 工作流，会先运行完整测试，再构建并发布预览。发布包包含页面、浏览器业务沙盒、字体、第三方许可证及演示 JSON，不包含服务端、正式账本或备份。

访问地址：<https://spicy-man.github.io/family-fund-manager/>。源码仓库的 **About → Website** 可填写同一地址。

### 行情与汇率的网络代理

外部行情与汇率请求优先使用 `HTTPS_PROXY` / `ALL_PROXY` 环境变量（也支持小写变量及 curl 的 `NO_PROXY` 规则）。Windows 未设置这些变量时，会自动读取当前用户已启用的系统代理，例如 Clash 的“系统代理”模式；关闭系统代理或未配置代理时直接联网，不需要安装 Clash，也不预设代理端口。系统代理配置每 30 秒重新读取一次。

可通过 `FUND_NETWORK_PROXY` 指定代理地址，或设为 `direct` 强制直连。此设置优先于环境变量与 Windows 系统代理，仅影响本系统的外部行情和汇率请求。例如在 PowerShell 中：

```powershell
$env:FUND_NETWORK_PROXY='direct'
npm start
```

Windows 自动读取支持手动系统代理及其绕过列表，不解析 PAC 自动配置脚本。macOS / Linux 如需应用代理，请配置上述环境变量。

## 基本使用顺序

1. 在“家庭成员管理”中添加成员，并指定一位主 GP。
2. 录入成员入金；基金资产变化后录入估值。
3. 按需登记出金或成员间转让。
4. 在“业绩结算”中先预览，核对估值日期和各 LP 明细，再确认结算。
5. 定期从“数据备份与恢复”导出 ZIP 快照，并保存到其他位置。

## 业绩结算规则

本系统深度致敬 **1956 年巴菲特早期合伙人基金（Buffett Partnership, Ltd.）** 的经典合伙契约，恪守“零固定管理费、达标才分成、GP 倾囊同投”的信托治理哲学。当前规则为年化 `6%` 复利门槛、超额部分 `25%` 业绩报酬、零固定管理费。

- 每笔 LP 入金或受让资金作为独立批次，按本期实际持有天数计算门槛，批次之间不对冲盈亏。
- 正式结算后重新计算下一期天数；每份份额的高水位 NAV 只升不降。
- 报酬通过 LP 向 GP 划转份额实现，不改变基金 NAV。
- 出金和转让会按规则同步结晶相关批次的业绩报酬。
- 正式结算会锁定结算日及以前的账目。结算不能直接修改或删除，只能从最近一笔开始倒序冲销。
- 确认结算前会核对预览凭证；账目、GP 或结算历史变化后需要重新预览。冲销明确指向页面显示的结算记录，重复提交不会继续撤销更早账期。升级或重启服务后请刷新旧页面并重新预览。
- 历史结算保存算法版本和结果快照，升级后仍按原规则重放。

完整口径、数例推演与治理条款请参阅 [基金管理准则](./docs/finance/基金管理准则.md)（系统内亦可通过侧边栏“基金管理准则”弹窗随时查阅）。

## 数据与备份

| 路径 | 内容 |
| --- | --- |
| `data/db.json` | 成员、普通账目和业绩报酬配置 |
| `data/cnh-rate-cache.json` | 当前 USD/CNH 汇率缓存（非账本数据） |
| `data/config.json` | 自选标的与两个自定义对比组合配置 |
| `data/settlements.json` | 结算、冲销、算法版本和锁定快照 |
| `data/index-cache.json` | 指数历史缓存，可重建 |
| `data/custom-benchmark-cache.json` | 自定义对比标的历史缓存，可重建 |
| `data/ticker-cache.json` | 标的行情缓存，可重建 |
| `backups/` | 写入前生成的完整 ZIP 快照，滚动保留最近 15 份 |

导出的 ZIP 包含三份核心数据文件。导入前会校验账本和历史结算，成功后原子替换当前数据；导入会覆盖现有账目，操作前应先导出一份当前快照。

不要在服务运行时手工编辑 `data/` 中的核心文件。迁移旧数据时请参阅 [数据迁移说明](./数据迁移说明.md)。

同一账本目录（默认 `data/`，或 `FUND_DATA_DIR` 指定的目录）只能由一个 Node.js 进程使用，即使监听不同端口也不能共用。启动时会先创建 `.fund-manager.lock/` 独占锁，再读取或恢复账本；遇到仍被占用或无法核实的锁会拒绝启动。正常退出会释放锁。不要让多个主机同时运行同一 NAS 账本。升级时必须先停止所有旧版本服务及脚本，再启动新版本；旧版本不会遵守此锁。

强制终止、断电等异常停止可能遗留锁。重新启动时，仅当锁记录属于本机且原进程已确认结束，系统才会自动恢复锁；并发启动只允许一个进程取得锁。其他主机、权限不足、锁信息缺失或异常等情况仍会拒绝启动。需要手工处理时，先确认所有主机上使用该账本的服务及脚本均已停止，备份账本目录，再手工删除该账本下的 `.fund-manager.lock/` 目录并重新启动。不要删除 `.snapshot-transaction.json`，重启会在取得锁后执行账本恢复。

使用 `start.command`（macOS）或 `start.bat`（Windows）启动后，可以直接点击启动终端窗口的叉号，或按 Ctrl+C 停止。启动窗口与服务通过进程连接绑定：即使 Windows 直接终止启动窗口，服务也会检测连接断开，退出并释放账本锁；未完成的 HTTP 请求最多等待 5 秒。关闭浏览器页面不会停止服务。再次启动或切换电脑前，请等待服务退出。断电、强杀服务进程本身等情况仍可能遗留锁，按上面的异常恢复说明处理。

## 开发

```bash
npm start    # 启动本地服务
npm test     # 运行完整回归测试（自动使用临时账本并关闭外部同步）
```

技术栈：Node.js、Express、原生前端 JavaScript、Chart.js、Decimal.js 和本地 JSON 存储。浏览器资源均由本机提供，运行时不依赖 CDN。

主要目录：

```text
docs/      架构、财务治理、开发规范与技术债务文档
lib/       核心计算、存储、结算和行情模块
routes/    API 路由与输入校验
public/    页面、样式和前端控制器
test/      自动化回归测试
data/      本地数据与可重建缓存
backups/   自动快照
```

## 许可证

本项目的原创代码采用 [MIT License](./LICENSE)，允许使用、修改、商用与再发布，使用或分发时须保留版权声明和许可证文本。软件按现状提供，不提供任何保证。

第三方组件与字体继续适用各自的许可证，详见下方开源致谢及对应许可证文件。

## 开源致谢

本项目建立在以下开源项目之上，感谢各位作者与维护者的贡献。

其中，按钮、导航与 tooltip 的液态玻璃效果来自 **[Hyalite](https://github.com/VII-Cae/hyalite--liquid-glass) v0.5.0**，由 **VII-Cae（VII）** 创作。Hyalite 通过透镜映射、SVG 位移滤镜与 `backdrop-filter` 实现背景折射；本项目在此基础上接入业务界面，将按钮、导航与 tooltip 的玻璃厚度固定为 20。仓库保留了上游源码中的版权声明与 [MIT 许可证全文](./public/vendor/hyalite/0.5.0/LICENSE)。

| 开源项目 | 在本项目中的用途 | 许可证 |
| --- | --- | --- |
| [Hyalite](https://github.com/VII-Cae/hyalite--liquid-glass) | 液态玻璃折射与边缘光照 | MIT |
| [Chart.js](https://github.com/chartjs/Chart.js) | 净值、业绩走势与成员资产占比图表 | MIT |
| [SortableJS](https://github.com/SortableJS/Sortable) | 拖拽排序 | MIT |
| [Decimal.js](https://github.com/MikeMcl/decimal.js) | 高精度财务计算 | MIT |
| [Express](https://github.com/expressjs/express) | 本地 Web 服务与 API | MIT |
| [ADM-ZIP](https://github.com/cthackers/adm-zip) | ZIP 备份与恢复 | MIT |
| [Inter](https://github.com/rsms/inter) / [Fontsource](https://fontsource.org/fonts/inter) | 界面正文字体，本地提供可变字体文件 | SIL OFL 1.1 |
| [Outfit](https://github.com/Outfitio/Outfit-Fonts) / [Fontsource](https://fontsource.org/fonts/outfit) | 标题与数字字体，本地提供可变字体文件 | SIL OFL 1.1 |

第三方组件与字体保留各自的版权及许可证，相关文本随其源码或安装包提供。上述许可证仅对应各项第三方内容，不代表本项目原创代码的授权协议。

## 项目文档

系统全部架构设计、业务治理、财务分析与开发规范文档归档于 [`docs/`](./docs/README.md) 目录中心；核心变更日志与操作说明位于根目录：

| 领域分类 | 文档 | 说明 |
|:---|:---|:---|
| **⚖️ 财务与治理** | [基金管理准则.md](./docs/finance/基金管理准则.md) | 10 项治理准则、计算案例及治理确认与审查附录 |
| | [收益率计算与退出机制分析.md](./docs/finance/收益率计算与退出机制分析.md) | 现行收益率口径与退出本金规则，附历史方案讨论 |
| **🏛 技术与架构** | [ARCHITECTURE.md](./docs/technical/ARCHITECTURE.md) | 整体分层架构、事件溯源计算、事务写入与数据流向 |
| | [CODE_REVIEW.md](./docs/technical/CODE_REVIEW.md) | 当前问题与销项总表、按日期归档的审查记录 |
| | [数据迁移说明.md](./数据迁移说明.md) | 旧账本与冷数据迁移恢复操作指南（根目录） |
| **📋 项目与规范** | [CHANGELOG.md](./CHANGELOG.md) | 完整的版本发布历史与技术特性演进（根目录） |
| | [COMMIT_GUIDE.md](./COMMIT_GUIDE.md) | Git 提交与版本发布规范指南（根目录） |
| | [TASKS.md](./docs/project/TASKS.md) | 系统改进任务、技术债及完成验证记录 |

## 常见问题

### 指数或标的行情没有更新

行情来自 Yahoo Finance，汇率带多数据源回退。网络请求失败不会影响本地账目和份额计算；恢复网络后可重试刷新。

### 历史账目无法修改

该日期可能已被业绩结算锁定。先倒序冲销最近的有效结算，修改账目后重新预览并确认。

### `3000` 端口被占用

使用上面的 `PORT` 环境变量指定其他端口，再访问对应地址。
