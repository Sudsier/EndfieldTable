# 终末地 Table 提取工作流（自包含版）

> 《明日方舟：终末地》(Arknights: Endfield) 游戏配置表（Table）的**最小化自动归档工作流**。
> 只下载 VFS Table 块（约 180MB，而非全量 50GB+），解密后用预编译的 AnimeStudio.CLI 提取为 JSON，
> 按「大版本 / 小版本」归类并推送到仓库的 `archive` 分支。

本文件夹**自包含**：预编译工具 + 代码 + 工作流 yml 全部就绪，**不需要现场编译**、不依赖仓库内其它任何代码。

---

## 1. 目录结构

```
workflow/
├── run.mjs                          # 主流程脚本（Node.js，零第三方依赖）
├── README.md                        # 本文档
├── .github/workflows/
│   └── table-extract.yml            # GitHub Actions 工作流（外部 HTTP 触发 + 并发控制）
├── tools/
│   └── AnimeStudio.CLI/             # 预编译的 CLI（net9.0-windows，framework-dependent）
│       ├── AnimeStudio.CLI.exe      #   <- 主程序
│       ├── AnimeStudio.dll / Newtonsoft.Json.dll / ...   # 托管依赖
│       ├── x64/ x86/                #   Windows 原生 dll（acl / sracl / FBXNative）
│       └── runtimes/                #   Texture2DDecoderNative 等
└── (运行时生成)
    ├── work/                        # 下载 + 解密中间产物（index_main_dec.json、VFS/42A8FCA6/）
    └── output/Table/                # 提取出的成品 JSON 表格
```

> 说明：`tools/AnimeStudio.CLI/` 是 **framework-dependent** 构建产物，运行时需要 **.NET 9**。
> 在 GitHub Actions 中由 `setup-dotnet` 提供运行时即可，**无需现场 `dotnet build`**。
> 想彻底免依赖可自行 `dotnet publish -c Release -r win-x64 --self-contained`，再替换 `tools/AnimeStudio.CLI/`。

---

## 2. 完整流程（`run.mjs` 六步）

| 步骤 | 内容 |
|------|------|
| Step 1 | 动态解析最新资源：`GET /game/get_latest` → 提取 `rand_str` → `GET /game/get_latest_resources` → 取 `name=main` 的 `path` 作为资源 base URL |
| Step 2 | **去重检查**：`archive-dir/table/{region}/{ver}/{fullVersionId}/` 已存在 → 直接跳过（无更新，退出码 0）；`--force` 可强制重跑 |
| Step 3 | 下载 `{base}/index_main.json` → Base64 解码 → **Vigenère 解密**（密钥 `Assets/Beyond/DynamicAssets/Gameplay/UI/Fonts/`）→ `index_main_dec.json` |
| Step 4 | 从索引筛出 Table 块（`VFS/42A8FCA6/`，blc+chk）并发下载到 `work/VFS/42A8FCA6/` |
| Step 5 | 调用 `AnimeStudio.CLI dump -s work -o output -b table` 提取 JSON 表格（SparkBuffer → JSON） |
| Step 6 | 复制 `output/Table/*.json` → `{archive-dir}/table/{region}/{ver}/{fullVersionId}/` |

版本归类命名（重要）：

- **大版本 ver**：来自资源路径中的 `1.4`（如 `.../1.4/resource/...`）
- **小版本 fullVersionId**：取**完整**小版本 ID，如 `9163343-11_UKLczw3HK1ELysvN`（含数字段 + 随机段，而非只有随机段 `UKLczw3HK1ELysvN`）

archive 分支上的归档结构：

```
table/
└── cn/                              # region（cn=国服 / os=国际服）
    └── 1.4/                         # 大版本
        └── 9163343-11_UKLczw3HK1ELysvN/   # 完整小版本 ID
            ├── CharacterTable.json
            ├── ActivityTable.json
            └── ... (约 690 个 JSON)
```

---

## 3. 部署到 GitHub

本文件夹是**最小化交付物**，上传后即可用。部署分两步：

### 3.1 上传内容到仓库

把 `workflow/` 整个文件夹上传到你 GitHub 仓库的根目录（保持目录名 `workflow`）：

```
你的仓库/
├── workflow/
│   ├── run.mjs
│   ├── README.md
│   ├── tools/AnimeStudio.CLI/...
│   └── .github/workflows/table-extract.yml
└── (其它文件)
```

### 3.2 让 Actions 识别 yml

GitHub 只扫描**仓库根目录**的 `.github/workflows/`。因此把 yml 复制到根目录：

```
你的仓库/
├── .github/workflows/table-extract.yml   # <- 复制自 workflow/.github/workflows/
└── workflow/
    └── ...
```

> 等价做法：直接把 `workflow/` 内容作为仓库根内容（`run.mjs`、`tools/`、`.github/` 都在根目录）——脚本用自身所在目录定位工具，两种放法都兼容。

### 3.3 前置准备

1. **创建 `archive` 分支**：在仓库里 `git checkout --orphan archive && git commit --allow-empty -m "init" && git push origin archive`（首次会 checkout 失败，故必须先创建）。
2. **开启写权限**：仓库 `Settings → Actions → General → Workflow permissions` 选择 **Read and write permissions**（否则无法 push 到 `archive`）。
3. **设置 Node / .NET**：Actions 会自动安装 Node 22 与 .NET 9 运行时，无需额外配置。

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
- **版本去重**：`run.mjs` Step 2 检查 `table/{region}/{ver}/{fullVersionId}/` 是否已存在（含 `.json`），存在则跳过下载/提取/推送（`git diff --cached` 为空 → 不产生 commit）。
- 因此每 5 分钟触发一次是**幂等**的：无新版本时不产生任何提交，只有出现新版本才归档。

---

## 6. 本地运行

需 Node.js ≥ 18 与 .NET 9 运行时（Windows）。

```bash
# 默认国服：动态获取 + 下载 + 提取（成品在 output/Table）
node workflow/run.mjs

# 指定 archive 分支 checkout 目录（做版本去重 + 归档同步）
node workflow/run.mjs --archive-dir ./archive-data

# 强制重跑
node workflow/run.mjs --archive-dir ./archive-data --force

# 指定渠道 / 指定资源地址（跳过动态获取）
node workflow/run.mjs --region os
node workflow/run.mjs --base https://.../1.4/resource/Windows/main/xxx/files
```

参数速查：

| 参数 | 说明 | 默认 |
|------|------|------|
| `--region` | 渠道 `cn`(国服) / `os`(国际服) | `cn` |
| `--base` | 直接指定资源 base URL，跳过动态获取 | 动态获取 |
| `--archive-dir` | archive 分支 checkout 目录；指定后启用去重 + 归档 | 不归档 |
| `--force` | 绕过 archive 已存在检查 | 关 |
| `--work` | 下载/解密中间目录 | `workflow/work` |
| `--out` | CLI 成品输出目录 | `workflow/output` |
| `--cli` | 覆盖 CLI 路径 | `workflow/tools/AnimeStudio.CLI/AnimeStudio.CLI.exe` |

---

## 7. 已知限制

- **需要 Windows runner**：CLI 目标框架为 `net9.0-windows` 且依赖 Windows 原生 dll，Actions 用 `windows-latest`。
- **3 个表格提取失败**（AnimeStudio 对负 offset 的解析边界问题，属工具本身）：`SpaceshipMusicTable.bytes`、`SpaceshipAlbumMusicTable.bytes`、`SpaceshipAlbumTable.bytes`。其余 690/693 个全部成功。
- 若游戏换新大版本（如 `1.5`），Table 块目录 `42A8FCA6` 理论上跨版本稳定；若失效，可从 `index_main_dec.json` 中重新按 `type=18` 定位新目录。
