# Pi session zstd 归档：插件边界与压缩策略调研

日期：2026-11-02。源码基线：`b26130fa73cdbf9930a13f003b9b4c1364c9af7d`。

本次只调研。未修改产品代码、真实 session、系统配置或 Git 历史。工作区原有未提交修改保持不动；源码定位以调研时工作区为准，其中 `session-manager.ts` 的既有改动与本结论涉及的压缩/发现机制无关。

## 结论

1. **现有公共扩展 API 可实现自定义归档命令、归档列表和选中后解压恢复，但不能完整覆盖原生启动与发现路径。** 若要求 `pi -c`、`pi -r`、`--session`、`/resume` 等保持原有透明体验，需要核心的 session 发现和打开流程支持压缩存档；不能只装一个依赖正常生命周期事件的插件。
2. **推荐每个 session 独立 zstd。** 活跃 session 继续写普通 JSONL，冷 session 才压缩；重新使用时恢复原始 JSONL，再沿用现有写入逻辑。后台冷归档可选 level 9；低延迟路径用 level 3。
3. **不推荐默认合并成一个连续压缩流。** 本次 level 9 的合并流只比独立文件额外省约 6.0%，却引入跨 session 顺序解码和删除、更新、损坏恢复的耦合。
4. **共享字典值得针对小文件单独评估，不推荐第一版默认自动训练和滚动替换。** 本次小文件确有收益，但对混合大小测试集，全量使用同一字典反而增大总存储；字典自身大小和长期保留成本不能忽略。这不证明其他训练策略无效。
5. 当前默认 session 路径位于已启用 `compression=zstd` 的 ZFS dataset。它提供磁盘块级透明压缩，但不是可独立搬移的 `.zst` 存档，也不减少 Pi 的逻辑 JSONL 扫描。不能把下表逻辑字节减少量当成这台机器的额外物理磁盘节省量。

## 1. 为什么纯插件不能完全透明

### 初始启动先读 session，后加载扩展

`main.ts` 先调用 `createSessionManager()`，确定有效 session/cwd，再建立运行时服务。扩展资源加载发生在后续 `createAgentSessionServices()` 的 `resourceLoader.reload()` 中。

因此，扩展的模块顶层或 async factory 也不能在这条正常 CLI 路径中抢在初始 session 发现/打开前运行。`session_start` 更晚。

证据：

- [`main.ts`](../packages/coding-agent/src/main.ts)：`createSessionManager()`，以及 `main()` 中先创建 manager、后调用运行时工厂的顺序。
- [`agent-session-services.ts:148–174`](../packages/coding-agent/src/core/agent-session-services.ts)：服务创建中的资源重载。
- [`extensions.md`](../packages/coding-agent/docs/extensions.md)：async factory、session 生命周期、只读 session context。

### 运行中有可用的恢复边界，但不是发现接口

`AgentSessionRuntime.switchSession()` 先发出 `session_before_switch`，再执行 `SessionManager.open()`。所以插件可在已知目标路径时，先把相应存档恢复到原 `.jsonl` 路径。

但：

- 原生列表不会先询问扩展如何列出压缩 session。
- `SessionBeforeSwitchResult` 只有 `cancel?: boolean`，没有正式的路径替换或存储后端注入契约。
- `ctx.sessionManager` 是只读状态接口；命令 context 才提供 `switchSession()`。
- 这条事件不能补上 CLI 初始 manager 创建前的缺口。

证据：[`agent-session-runtime.ts`](../packages/coding-agent/src/core/agent-session-runtime.ts) 的 `switchSession()`；[`extensions/types.ts:326–336、402–436、774–778、1514–1516`](../packages/coding-agent/src/core/extensions/types.ts)。

### 现有文件发现与读取只支持普通 JSONL

`findMostRecentSession()`、`listSessionsFromDir()`、`findById()`、`listAll()` 都只筛选 `.jsonl`。`loadEntriesFromFile()` 按 UTF-8 逐行解析，`buildSessionInfo()` 则读取全文以生成搜索文本和列表元数据。写入使用普通 JSONL append，部分恢复/迁移/compaction 流程会重写文件。

证据：[`session-manager.ts`](../packages/coding-agent/src/core/session-manager.ts) 中上述函数及 `_setSessionFile()`、`_persist()`、`commitContinuation()`。

合成 session 验证结果：

- `.jsonl.zst` 被列表、最近 session、精确 ID 查询忽略。
- 直接 `SessionManager.open()` 压缩文件时报无效 session，压缩原件保持不变。
- 仅向低层 `SessionManager.open()` 传入已经不存在的原 `.jsonl` 路径，会获得新 session 身份，不会自动寻找旁边的存档。
- 先无损恢复成 `.jsonl` 后，原 ID、消息和普通 append/list 均正常。

验证脚本：`/var/tmp/pi-session-zstd-research.mjs`。只操作合成数据。

### 可行方案边界

| 方案 | 能做到什么 | 不满足什么 |
|---|---|---|
| 纯插件自定义 `/archives` 一类入口 | 独立目录发现存档，选中后解压，再调用 `ctx.switchSession()` | 原生启动、列表和所有外部工具并不因此自动兼容 |
| 核心发现/打开支持 + 插件归档策略 | 保留原生入口；插件决定何时归档、显示状态和配置策略 | 需要一小块核心集成；并发归档安全不能只靠生命周期事件 |
| SDK 宿主先解压再创建 manager | 宿主拥有的启动和恢复流程可透明处理 | 不等于现有 CLI 插件能力 |
| ZFS/Btrfs 文件系统透明压缩 | Pi 无需感知，读写接口不变 | 不生成独立 `.zst` 归档；也不实现应用层冷热目录 |

不采用 monkey-patch 核心类或伪造 JSONL 占位文件：前者缺少稳定契约，后者会让初始加载误读为不完整历史，且无法保留全文搜索等行为。

## 2. Pi Durable 能否直接复用

**不是现成替换件。** Durable 的 `Storage` 以原子 commit、conversation/entry/task/document 等记录和范围扫描为契约；coding-agent 的 `SessionManager` 是 JSONL 树及活动叶节点管理器，两者接口与存储模型不同。

Durable JSONL 后端使用目录下的 `main.jsonl` 及 document/task sidecar，并未提供现成的 session zstd 冷归档。其 README 明确规定一个进程拥有一个 storage，不提供跨进程锁。

采用边界：可以参考其明确的存储契约和持久化顺序；本需求不应为了压缩文件而迁移到整个 Durable harness。

证据：

- [`packages/durable/README.md` 的 Storage 节](../packages/durable/README.md#storage)
- [`packages/durable/src/types.ts` 的 `Storage`](../packages/durable/src/types.ts)
- [`packages/durable/src/storage/jsonl/storage.ts`](../packages/durable/src/storage/jsonl/storage.ts)

未取得足够的一手来源证明 Codex/Hermes 已实现同类本地透明 zstd session 归档，故不以这些说法作为设计依据。

## 3. 压缩粒度与字典不是同一个选择

- **独立文件**：每个 session 一个独立压缩单元，恢复一个不需要解码其他 session。
- **合并连续流**：先拼接/打包，再一起压缩。可以利用窗口内的跨 session 重复，但访问后面的 session 通常必须从前面的解码边界开始。
- **独立 frame 的合并容器**：每个 session 仍独立压缩，再用索引指向各 frame。可单独读取，但压缩历史不跨 frame 共享；还需容器索引、删除和回收机制。不是连续流的免费随机访问版。
- **共享训练字典**：可与独立文件组合。先从旧 session 训练字典，解码任何引用它的存档时都必须有对应字典。

Zstandard 官方说明，字典主要改善前几 KiB，小样本且数据类型相关时收益更明显；随着文件变大，文件自身已解码内容会逐渐承担字典作用。`zstd --train` 是离线统计训练，不需要 LLM。

来源：

- [Zstandard 官方 README：字典训练](https://github.com/facebook/zstd/blob/dev/README.md#the-case-for-small-data-compression)
- [官方 zstd CLI 手册](https://github.com/facebook/zstd/blob/dev/programs/zstd.1.md)
- [官方 seekable format：独立 frame 与 seek table](https://github.com/facebook/zstd/blob/dev/contrib/seekable_format/zstd_seekable_compression_format.md)

## 4. 真实 session 离线实测

用户明确授权本机真实 session 只读抽样。没有上传或输出正文；真实压缩样本和字典只写入私有临时目录。未调用可能修复或迁移原文件的 `SessionManager` 读取函数。

### 方法

- 仅扫描默认 session 根目录下各项目的顶层 `.jsonl`，不递归子代理产物。
- 排除最近 24 小时修改的文件、空文件、32 MiB 以上文件和选中后检测到变化的文件。
- 按文件大小分层；每层较旧 70% 为训练候选、较新 30% 为测试候选；固定 hash 顺序抽样，移除选中内容的完全重复项。
- 训练集：199 文件、134 项目、41,279,639 字节。测试集：115 文件、92 项目、81,112,563 字节，约 77.35 MiB。
- 两种字典：32 KiB、112,640 字节；只用训练集生成，测试集不参与训练。CLI 可能限制单个训练样本实际使用的字节，因此上述训练字节不是保证全部进入训练器的有效字节数。
- Node v26.12.1、zstd CLI 1.5.7。相同压缩 level 和 frame checksum 设置；每种模式重复 3 次，报告中位数。
- 2,760 次逐 session 字节一致性检查通过；独立模式和合并流均检查完整恢复。
- 原始冷文件元数据分布：7,443 个，中位数 2,113 字节，P90 为 991,471 字节，P99 为 12,508,234 字节。测试样本刻意增加大文件比例，**不是全库加权抽样**。

### 全部测试文件的逻辑存储体积

字典模式包含一份字典的大小。合并流只计拼接内容的压缩体积，**未计 tar/目录/索引开销，是偏有利的体积下界**。

| 方式 | level 3 | level 9 | 相对同 level 独立压缩 |
|---|---:|---:|---|
| 每 session 独立，无字典 | 31.09 MiB | 29.57 MiB | 基线 |
| 所有测试文件合并连续流 | 29.53 MiB | 27.78 MiB | 再省约 5.0% / 6.0% |
| 独立 + 32 KiB 共享字典 | 31.24 MiB | 31.18 MiB | 反而增加约 0.49% / 5.46% |
| 独立 + 112,640 字节共享字典 | 31.20 MiB | 31.15 MiB | 反而增加约 0.37% / 5.35% |

无字典独立压缩从 level 3 提升到 9，压缩后体积额外减少约 4.9%。这台主机上，整个测试集的内存压缩中位耗时约由 182 ms 增至 733 ms，约 4 倍。适合后台冷归档，不宜把这组缓存内存数字当作完整交互延迟承诺。

### 字典对小文件的收益

以下为相对同 level、无字典的**压缩载荷**减少比例；此分层表没有再次把共享字典体积摊进每一层。

| 文件大小 | 32 KiB 字典，level 9 | 112,640 字节字典，level 9 |
|---|---:|---:|
| <16 KiB | 42.1% | 59.9% |
| 16–128 KiB | 20.6% | 30.6% |
| 128 KiB–1 MiB | 2.3% | 4.0% |
| 1–8 MiB | 增大 6.6% | 增大 6.2% |
| 8–32 MiB | 增大 6.1% | 增大 6.1% |

解释：很多小文件复用一个字典时可明显受益；对所有大小的 session 强制套同一字典并不好。若后续引入字典，应针对小文件，并以包含字典成本的未见样本收益作为启用条件，而不是因“自动训练”就默认认为更省。

### 恢复成本

无字典独立 level 9 的单文件内存解码 P50 约 0.016 ms、P95 约 2.80 ms；合并流整流解码约 68 ms，生成约 77.35 MiB 原始数据。

这不是等价完整恢复端到端测试：独立文件只解一个文件；合并流测的是完整解码再按边界取出目标，属于未优化上界，没有测可提前终止的前缀解码。两者均不包含磁盘 IO、解压文件落盘、session JSON 解析和 UI 恢复。这里只证明访问粒度差异，不能外推固定倍数。

### 其他限制

没有测自动重训/字典轮换、按项目特训、超大 session、长距离匹配、seekable 容器或真实物理磁盘节省。测试顺序固定，主机未做 CPU 隔离。峰值 RSS 约 664 MiB，来自基准批量持有数据；不是推荐的生产内存策略。只有完全重复内容被去除，fork 的重复前缀可能仍存在。

## 5. 若后续实现，最小方案需要守住什么

以下是设计边界，不是本次实现承诺。

1. **按 session 独立归档，活跃写入仍是 JSONL。** 不在每次 append 后重压整个历史。
2. **核心发现与打开共享同一套存档识别/恢复逻辑。** 覆盖初始恢复、ID 查找、最近 session、列表、fork/import/export 以及改名/删除，而不是仅适配 `/resume`。删除不能只删解压副本、下次又被存档“复活”。保留原 session ID、历史、父 session 引用和排序语义；不能用归档生成时间代替会话活动时间。
3. **列表与全文搜索分开考虑。** 只显示标题、时间、cwd 等可用小型元数据；当前原生搜索依赖 `allMessagesText`。保留全文搜索就必须按需解码扫描，或维护额外搜索索引。不能同时承诺“无需解码/无需索引”且“完整全文搜索不变”。
4. **原子发布与并发所有权是必要条件。** 压缩到同目录临时文件，完成校验和持久化后再发布。必须有会话写入方也遵守的互斥/租约；只判断 mtime、只排除当前插件所在 session 或只拿插件自己的锁，都不足以阻止其他 Pi 进程在压缩与移除原文件之间追加内容。没有协调能力时，归档工作限定在确认无写入者的离线窗口。
5. **如使用字典，版本不可原地覆盖。** 每个存档记录字典引用和可靠身份校验，先发布字典再发布依赖存档；旧字典一直保留到没有存档引用。复制/备份存档时同时携带字典。缺少或错误字典应明确报错，不当作空/新 session。
6. **字典同样敏感。** 字典可能保留训练样本中的原文片段，不是匿名统计，也不是加密。与 session 使用相同权限和备份边界。对不可信压缩输入限制解码大小/内存，校验完成才替换正常文件。

## 6. 产物与复现

- 基准脚本：`/var/tmp/pi-session-zstd-study-FOMxwaYW/benchmark.mjs`
- 去正文汇总：`/var/tmp/pi-session-zstd-study-FOMxwaYW/aggregate-results.json`
- 私有产物：同目录的训练路径清单、`.zdict`、`compressed.private/`。目录权限 0700，脚本设置 umask 0077。**这些私有产物不可直接公开。**
- 本次实际执行命令：`nice -n 10 node /var/tmp/pi-session-zstd-study-FOMxwaYW/benchmark.mjs`。重现实验时，先创建新的私有输出目录，并将脚本的 `scratch` 常量改为该目录；不要直接覆盖本次产物。脚本使用固定抽样算法，但文件年龄/元数据会随时间改变，因此不是冻结输入清单的字节级复现实验；已有聚合数据保留本次结果。
- 合成字典 API 探针：`/var/tmp/pi-zstd-dictionary-probe.mjs`。Node v26.12.1 和 Bun 1.4.4 均验证字典确实参与编码、可逐字节恢复、缺字典不能正确解码；未单独验证已安装 Pi 二进制的嵌入式 Bun。

其他权威参考：[Node zlib/zstd 文档](https://nodejs.org/docs/latest-v22.x/api/zlib.html)、[OpenZFS compression 属性](https://openzfs.github.io/openzfs-docs/man/master/7/zfsprops.7.html)。

本次未运行项目构建或全量测试；未安装依赖；未实现插件或核心 patch；未提交、推送或向上游发送信息。私有临时产物未删除，清理需另行确认。
