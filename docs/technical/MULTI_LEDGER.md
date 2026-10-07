# 多账本

标题下只显示当前账本名称。打开下拉菜单可切换账本或进入“管理账本”。管理窗口复用家庭成员管理布局，在其中添加账本、编辑名称，再点击“保存账本设置”。首次打开默认进入账本1；切换通过页面 URL 的 ledger 参数保存到当前标签页，并重新加载页面以清除旧表单与预览。

- 默认账本保持原有 data/db.json 和 data/settlements.json，不迁移真实数据。
- 新账本按顺序存放于 data/ledger-2、data/ledger-3 等子目录。每个目录保存自己的 db.json、settlements.json、账本名称和事务恢复标记。备份统一放在外层 backups：默认账本仍使用 backups 根目录，新账本分别使用 backups/ledger-2、backups/ledger-3 等子目录；设置 FUND_BACKUP_DIR 时也使用该目录下的账本子目录。默认账本改名保存在 data/ledger.json 中；不改变其数据路径。
- benchmark、ticker、行情历史、缓存和当前汇率共用默认 data 目录的配置和缓存，切换不重新配置。GP 和费用规则引用账本成员，因此仍随记账数据保存。
- 子目录内 config.json 是事务恢复与备份快照的副本；运行时读取默认账本的共用配置，子账本导入不会用备份的 config.json 覆盖共用 benchmark/ticker 设置。
- 请求通过 X-Ledger-Id 明确选择账本；无选择时使用默认账本。备份下载通过 ledger 查询参数选定账本。无效 ID、目录别名、冲突选择均拒绝，不回退到默认账本。
- 各账本拥有独立存储锁、计算缓存和结算签名；共用行情同步队列和 ticker 刷新任务，避免异步覆盖。切换不改变其他标签页的选择。
- 这是同一系统中的记账数据分组，不提供用户账户或访问权限隔离。保留现有本机访问策略。

验证：test/test-ledgers.js 覆盖默认兼容、三个账本并发成员写入、共用设置、无效选择、备份导出与导入。test/test-ledger-workers.js 覆盖共用行情任务串行与 ticker 去重。所有服务测试使用临时目录并禁用真实外部同步。

## 本轮文件清单

新增：lib/ledgers.js、public/js/ledger-switcher.js、test/test-ledgers.js、test/test-ledger-workers.js、docs/technical/MULTI_LEDGER.md。

修改：lib/storage.js、server.js、routes/tickers.js、public/index.html、public/css/base-navigation.css、public/css/overlays.css、public/js/api.js、public/js/app.js、public/js/onboarding-controller.js、scripts/run-tests.js。

无删除文件，无数据迁移，无发布、打包、提交或推送。

## 验收

2026-10-07：全部 50 个隔离回归脚本通过，git diff --check 通过。浏览器验证标题下入口、新建账本、窄屏切换回默认账本，未发生页面 JavaScript 错误。独立审查发现的共享行情异步覆盖、自动备份旧配置两项已修复并补测，修复后两位独立审查者重新复核均通过。真实 data 和 backups 未改动；临时界面服务已关闭。

Windows 验证时 NAS node_modules 只有 macOS esbuild，测试使用匹配版本的临时 Windows esbuild 可执行文件；未更改共用 node_modules。

后续界面修正：去掉菜单中的独立新建项与独立新建弹窗；复用 member-modal-content、添加表单、卡片列表与底部保存组件。浏览器验证切换按钮与导航左右边缘误差小于 1px；窗口内添加、改名保存、浅色/深色与 390px 窄屏均通过，无页面错误或横向溢出。前端语法和 CSS 模块检查通过。

成员改名修复：底部“保存成员设置”原先仅关闭窗口，未提交编辑中的姓名。现改为先提交当前姓名编辑，全部成功后关闭；空姓名或请求失败时保留窗口与草稿，底部按钮保存期间禁止重复点击。临时账本2浏览器验证底部保存后重载仍保留新名称、默认账本成员未改变。

本次修改：public/js/member-editor-controller.js、public/js/app-shell-controller.js、public/js/app.js、test/test-app-controller-boundaries.js、docs/technical/MULTI_LEDGER.md。无新增或删除源文件，真实账本未改动，无提交或推送。成员控制器回归、前端语法检查和实际浏览器验证通过。

成员图标对齐修正：编辑与取消时脚本将按钮显示布局改为 inline-flex，覆盖原 grid 居中规则。统一保持 grid，并显式保证图标居中。修改 public/js/member-editor-controller.js、public/css/responsive-members.css 及本说明，无新增或删除源文件。浏览器测量桌面与手机宽度下编辑、确认、成功保存后、取消后和未改名确认后的图标中心偏移均小于 0.6px；成员控制器回归及前端语法检查通过。

备份目录修正：新账本备份统一使用外层 backups/<账本 ID>/，继承 FUND_BACKUP_DIR 设置。账本2已有的 17 个备份文件已从 data/ledger-2/backups 搬到 backups/ledger-2，逐文件校验内容一致。多账本备份与共用任务回归通过。正在运行的服务需重启才能使用新路径。data/books 与 backups/books 未被当前代码引用，保留旧文件以免丢失历史备份。

本轮工作区独立审查：两位独立审查者分别检查完整改动，修复后循环复核，最终无遗留的已发现问题。修复已有子账本首次打开时遗漏的基准行情同步、账本名称输入框 Escape 冒泡关闭窗口、成员底部保存期间编辑竞争，以及创建账本失败留下不可见目录的问题。创建初始化不会轮换删除历史快照；失败仅清理本次目录与新增快照，保留既有备份，重试不消耗编号。初次账本列表加载失败也可再次点击重试。

新增 test/test-ledger-startup-sync.js、test/test-ledger-switcher.js，扩充成员控制器与多账本故障回归；覆盖初始化/快照/元数据发布失败、15 份历史快照的文件集合与逐文件内容一致、正常写入恢复备份轮换。并行新增的隐私状态传递改动及 test/test-settings-privacy.js 也纳入两轮独立审查。最终全部 53 个隔离回归脚本通过，git diff --check 通过。本轮审查未修改真实账本或备份，未提交或推送。

成员编号（2026-10-08）：新建账本的默认成员现在分别生成 mem_<UUID>，不再复用 me/mother/father。成员设置显示可编辑的唯一编号（1–64 位字母、数字、下划线或短横线），编号变更检查当前所有账本并拒绝冲突。后端以原始普通账本及完整独立结算账本作联合快照写入，同步更新 GP 配置、交易双方、历史报酬参数、LP 名单和结算快照；迁移前后进行完整计算比对及锁定快照校验。姓名、备注、事件编号、来源批次编号不作文本替换。编号只标识当前成员记录，不按同名或家庭关系推断跨账本的自然人身份；未来同一人的合并展示应使用显式身份关联。导入其他账本备份仍可复制成员编号，合并展示必须保留账本来源，不能只凭编号合并复制记录。

新增 lib/member-identifiers.js、scripts/migrate-member-identifiers.js、test/test-member-identifiers.js。离线迁移脚本仅转换旧 me/mother/father，保留手动编号和 UUID；获取全部账本锁后，先保留逐字节原始 ZIP 及旧新编号对照，再校验所有账本并分别原子写入。真实账本已迁移 5 个旧编号，原始备份位于 backups/member-id-migration-2026-10-07T16-14-39-005Z。两个账本重放校验通过；整套隔离回归通过，浏览器确认成员设置显示新编号，本地服务已重启。

编号与界面修订（2026-10-08，替代上一段的跨账本冲突规则）：默认编号改为随机六位数字，自动生成时避开已有账本编号，并在随机碰撞时重试。手动改编号要求六位数字，只检查同一账本内重复；同一个人可在多个账本手动指定相同编号。现有六条成员记录已缩短编号，并按用户明确的同人关系，将两个账本的卜梵统一为 679582；王寒敏 920922、梁蕴怡 106998，不依据同名自动匹配其他人。迁移前原始备份与映射保存于 backups/member-id-migration-2026-10-07T16-22-58-718Z。完整重放与结算快照校验通过。计算与结算按账本成员顺序遍历，避免数字对象键的自动排序改变快照顺序。

成员卡片改为姓名/角色与编号两行，编号按需点击编辑，使用底部保存。固定卡片不收缩，手机端 GP 选择与操作按钮分占两行，六位编号完整可见。桌面及 390px 手机宽度已检查，无内容越界。全部隔离回归及 CSS 检查通过。浏览器演示环境同步支持六位随机编号及编号引用迁移。
