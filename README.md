# 终末地 Table 提取工作流（免环境自包含版）

> 《明日方舟：终末地》(Arknights: Endfield) 游戏配置表（Table）的**最小化自动归档工作流**。
> 只下载 VFS Table 块（约 180MB，而非全量 50GB+），用**自包含**解包工具提取为 JSON，
> 按「大版本 / 小版本」归类推送到仓库的 `archive` 分支，
> 并在每次更新时把**活动简化 JSON**（`activity-summary.json`）覆盖写入 `archive` 分支根目录。

本文件夹**自包含 + 免环境**：主流程打成单文件 `run.exe`（pkg 打包，内置 Node 18 运行时），
解包工具为自包含 `AnimeStudio.CLI.zip`（内置 .NET 运行时）。**GitHub Actions 上无需安装 Node / .NET**，
直接运行 `run.exe` 即可。

---

## 1. 目录结构

```
workflow/
├── run.cjs                           # 主流程脚本源码（CJS，node run.cjs 可直接跑）
├── run.exe                           # pkg 打包产物（单文件，内置 Node 18，action 用这个）
├── activity-summary.cjs              # 活动聚合逻辑（CJS 版，由 activity-summary/activity-summary.mjs 转换）
├── build.mjs                         # 构建脚本：重新发布自包含 CLI + pkg 打包 run.exe
├── README.md                         # 本文档
├── .github/workflows/
│   └── table-extract.yml             # GitHub Actions 工作流（外部 HTTP 触发 + 并发控制）
├── tools/
│   └── AnimeStudio.CLI/
│       └── AnimeStudio.CLI.zip       # 自包含解包工具（内置 .NET 运行时，约 38MB）
│                                     # 首次运行时由 run.exe 自动解压出 AnimeStudio.CLI.exe
└── (运行时生成)
    ├── work/                         # 下载 + 解密中间产物（index_main_dec.json、VFS/42A8FCA6/）
    └── output/Table/                 # 提取出的成品 JSON 表格
```

> `AnimeStudio.CLI.zip` 是 `dotnet publish -r win-x64 --self-contained -p:PublishSingleFile=true
> -p:IncludeNativeLibrariesForSelfExtract=true` 的产物（约 93MB exe 压缩到 38MB）。
> 运行时自解压，**无需安装 .NET**。

---

## 2. 完整流程（`run.cjs` 七步）

| 步骤 | 内容 |
|------|------|
| Step 1 | 动态解析最新资源：`GET /game/get_latest` → 提取 `rand_str` → `GET /game/get_latest_resources` → 取 `name=main` 的 `path` 作为资源 base URL |
| Step 2 | **去重检查**：`archive-dir/table/{region}/{ver}/{fullVersionId}/` 已存在 → 直接跳过（无更新，退出码 0）；`--force` 可强制重跑 |
| Step 3 | 下载 `{base}/index_main.json` → Base64 解码 → **Vigenère 解密**（密钥 `Assets/Beyond/DynamicAssets/Gameplay/UI/Fonts/`）→ `index_main_dec.json` |
| Step 4 | 从索引筛出 Table 块（`VFS/42A8FCA6/`，blc+chk）并发下载到 `work/VFS/42A8FCA6/` |
| Step 5 | 调用自包含 `AnimeStudio.CLI dump -s work -o output -b table` 提取 JSON 表格（SparkBuffer → JSON；exe 缺失时自动解压 zip） |
| Step 6 | 复制 `output/Table/*.json` → `{archive-dir}/table/{region}/{ver}/{fullVersionId}/` |
| Step 7 | 生成**活动简化 JSON**（`activity-summary.json`）→ `{archive-dir}` 根目录（每次更新直接覆盖；`--no-summary` 关闭，`--lang JP` 换语言） |

版本归类命名（重要）：

- **大版本 ver**：来自资源路径中的 `1.4`（如 `.../1.4/resource/...`）
- **小版本 fullVersionId**：取**完整**小版本 ID，如 `9433094-12_kPjyuLMamMsWmwmd`（含数字段 + 随机段）

archive 分支上的归档结构：

```
activity-summary.json               # 活动简化 JSON（甘特图数据源，每次更新覆盖）
table/
└── cn/                              # region（cn=国服 / os=国际服）
    └── 1.4/                         # 大版本
        └── 9433094-12_kPjyuLMamMsWmwmd/   # 完整小版本 ID
            ├── CharacterTable.json
            ├── ActivityTable.json
            └── ... (约 690 个 JSON)
```

活动简化 JSON 的字段结构见 [activity-summary/README.md](../activity-summary/README.md)。

---

## 3. 部署到 GitHub

本文件夹是**最小化交付物**，上传后即可用。部署分两步：

### 3.1 上传内容到仓库根目录

把 `workflow/` 文件夹里的**所有内容**直接上传到你的 GitHub 仓库**根目录**（**不要再**建一层 `workflow/` 子目录）：

```
你的仓库/（根目录）
├── run.exe                          # 单文件主流程（免 Node）
├── activity-summary.cjs             # 活动聚合逻辑（run.exe 内嵌，保留一份便于查看/直跑）
├── tools/
│   └── AnimeStudio.CLI/
│       └── AnimeStudio.CLI.zip      # 自包含解包工具（免 .NET）
└── .github/
    └── workflows/table-extract.yml  # GitHub 自动识别根目录 .github/workflows/ 下的 yml
```

> 注意：`run.exe` 与 `tools/` 必须在**同一目录**（仓库根目录），缺一不可；
> `run.exe` 用自身所在目录定位 `tools/`，不依赖当前工作目录。

### 3.2 前置准备

1. **开启写权限（必需）**：仓库 `Settings → Actions → General → Workflow permissions` 选择 **Read and write permissions**（否则无法 push 到 `archive`）。`archive` 分支**无需手动创建**——工作流首次运行时会自动创建（远程不存在则从空 orphan 分支推建，已存在则检出最新内容增量追加）。
2. **无需安装任何运行时**：Node 与 .NET 都已内置在 `run.exe` / `AnimeStudio.CLI.zip` 中。

---

## 4. 触发方式（每 5 分钟）

### 4.1 外部 HTTP 触发（repository_dispatch，推荐）

在 cron-job.org 等定时服务（每 5 分钟）请求：

```
POST https://api.github.com/repos/{owner}/{repo}/dispatches
Authorization: Bearer {PAT}
Content-Type: application/json

{
  "event_type": "table-extract",
  "client_payload": {
    "region": "cn",
    "force": "false"
  }
}
```

- `{PAT}`：仓库 Token（`repo` 权限）或 fine-grained PAT；也可在 Settings → Developer settings → **Personal access tokens** 生成。
- `region` 可选，默认 `cn`；`force` 可选，`true` 时强制重跑。

### 4.2 手动触发（workflow_dispatch）

仓库 `Actions → table-extract → Run workflow`，可选填 `region` / `force`。

---

## 5. 并发与去重保证

- **并发控制**：yml 使用 `concurrency: group: table-extract`，同一时刻只跑一个实例；若上一个没跑完，新触发会排队等待，不会出现两个 action 同时写 `archive` 分支。
- **版本去重**：`run.cjs` Step 2 检查 `table/{region}/{ver}/{fullVersionId}/` 是否已存在（含 `.json`），存在则跳过下载/提取/推送（`git diff --cached` 为空 → 不产生 commit）。
- 因此每 5 分钟触发一次是**幂等**的：无新版本时不产生任何提交，只有出现新版本才归档（此时 `activity-summary.json` 一并覆盖更新）。

---

## 6. 本地运行与重新构建

### 6.1 本地运行（需 Node.js >= 18）

```bash
# 在仓库根目录执行（也可直接跑 run.exe，效果一致）
node workflow/run.cjs

# 指定 archive 分支 checkout 目录（做版本去重 + 归档同步 + 生成 activity-summary.json）
node workflow/run.cjs --archive-dir ./archive-data

# 强制重跑 / 指定渠道 / 指定资源地址
node workflow/run.cjs --archive-dir ./archive-data --force
node workflow/run.cjs --region os
node workflow/run.cjs --base https://.../1.4/resource/Windows/main/xxx/files
```

参数速查：

| 参数 | 说明 | 默认 |
|------|------|------|
| `--region` | 渠道 `cn`(国服) / `os`(国际服) | `cn` |
| `--base` | 直接指定资源 base URL，跳过动态获取 | 动态获取 |
| `--archive-dir` | archive 分支 checkout 目录；指定后启用去重 + 归档 + 活动 JSON | 不归档 |
| `--force` | 绕过 archive 已存在检查 | 关 |
| `--lang` | 活动简化 JSON 语言（I18nTextTable_XX 后缀） | `CN` |
| `--no-summary` | 关闭活动简化 JSON 生成 | 开 |
| `--work` | 下载/解密中间目录 | `./work`（脚本所在目录下） |
| `--out` | CLI 成品输出目录 | `./output`（脚本所在目录下） |
| `--cli` | 覆盖 CLI 路径 | `./tools/AnimeStudio.CLI/AnimeStudio.CLI.exe` |

### 6.2 重新构建产物（需 dotnet SDK 9 + pkg）

```bash
node workflow/build.mjs            # 重新发布自包含 CLI zip + pkg 打包 run.exe
node workflow/build.mjs --no-cli   # 只重新打包 run.exe
```

> 修改 `run.cjs` / `activity-summary.cjs` 后需重新 `pkg` 打包才会生效；
> 修改 `AnimeStudio/AnimeStudio.CLI` 源码后需重新 `dotnet publish` + 压缩 zip。

---

## 7. 已知限制

- **需要 Windows runner**：CLI 为 win-x64 自包含构建，Actions 用 `windows-latest`；`run.exe` 也是 win-x64。
- **首次运行需解压 CLI**：`AnimeStudio.CLI.zip`（约 38MB）解压出 93MB exe，需数秒，只发生一次（解压后保留）。
- **3 个表格提取失败**（AnimeStudio 对负 offset 的解析边界问题，属工具本身）：`SpaceshipMusicTable.bytes`、`SpaceshipAlbumMusicTable.bytes`、`SpaceshipAlbumTable.bytes`。其余 690/693 个全部成功（自包含版实测 693/693）。
- 若游戏换新大版本（如 `1.5`），Table 块目录 `42A8FCA6` 理论上跨版本稳定；若失效，可从 `index_main_dec.json` 中重新按 `type=18` 定位新目录。
