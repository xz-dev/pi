# Delivery

- 类型：仅调研，未形成实现变更。`research.md` 是 2026-11-02 调研原文的逐字副本（原路径 `docs/session-zstd-research.md`，源码基线 `b26130fa73cdbf9930a13f003b9b4c1364c9af7d`）。
- 后续走向：`patch/session-compression` 先实现过离线迁移式 session 压缩（`afbde0f36`），随后改为磁盘压缩指引（`4fc7aab00 fix(coding-agent): replace session compression with disk compression guidance`）。本调研的每 session 独立 zstd 归档方案未进入产品代码。
- 调研引用的 `/var/tmp/pi-session-zstd-study-FOMxwaYW/` 私有产物不在本存档内，也不应公开。
- 2026-11-18 存档。
