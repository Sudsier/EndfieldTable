#!/usr/bin/env node
/**
 * run.cjs — 《明日方舟：终末地》Table 提取工作流（CJS / 单文件可执行版）
 *
 * 由 run.mjs 演化而来（import -> require，import.meta.url -> 可执行目录定位），
 * 既可直接 `node run.cjs` 运行，也可用 pkg 打包为单文件 run.exe 在
 * GitHub Actions（windows-latest）上免 Node / 免 .NET 运行：
 *
 *   pkg run.cjs -t node18-win-x64 -o run.exe
 *
 * 完整流水线（默认国服）：
 *   1. 动态解析最新资源 base URL（get_latest -> get_latest_resources）
 *   2. 从 base URL 提取 大版本(ver) + 小版本(fullVersionId，如 9163343-11_UKLczw3HK1ELysvN)
 *   3. 若指定 --archive-dir 且 table/{region}/{ver}/{fullVersionId}/ 已存在 -> 跳过（无更新）
 *   4. 下载 index_main.json -> Base64 解码 + Vigenère 解密 -> index_main_dec.json
 *   5. 从索引筛出 Table 块（type=18 / VFS/42A8FCA6/）并发下载 blc + chk
 *   6. 调用自包含 AnimeStudio.CLI dump -b table 提取 JSON 表格
 *      （tools/AnimeStudio.CLI/AnimeStudio.CLI.exe 不存在时自动从同目录 zip 解压）
 *   7. 复制 output/Table -> {archive-dir}/table/{region}/{ver}/{fullVersionId}/
 *   8. 生成活动简化 JSON（activity-summary.json）-> {archive-dir} 根目录（每次更新覆盖）
 *
 * 用法：
 *   node run.cjs                                        # 默认国服：动态获取 + 下载 + 提取
 *   node run.cjs --archive-dir ./archive-data           # 额外同步成品到 archive 分支 checkout 目录（含跳过检查）
 *   node run.cjs --force                                # 强制重跑（绕过 archive 已存在检查）
 *   node run.cjs --region cn|os                         # 渠道：cn=国服(默认) / os=国际服
 *   node run.cjs --base <url>                           # 跳过动态获取，直接指定资源 base URL
 *   node run.cjs --lang CN                              # 活动简化 JSON 的语言（I18nTextTable_XX）
 *   node run.cjs --work <dir> --out <dir> --cli <exe>
 *
 * 依赖：Node.js >= 18（内置 fetch，无需任何第三方包）；
 *       解包工具 AnimeStudio.CLI 为自包含单文件（内置 .NET 运行时，无需安装）。
 */
const { mkdir, writeFile, access, readdir, copyFile } = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------- 常量（逆向自 archive 项目与 AnimeStudio 源码） ----------
const RES_INDEX_KEY = 'Assets/Beyond/DynamicAssets/Gameplay/UI/Fonts/'; // Vigenère 密钥
const BLOCK_DIR = '42A8FCA6'; // Table 块目录（type=18），跨版本稳定
const USER_AGENT = 'Mozilla/5.0';
const CONCURRENCY = 8; // 下载并发数

// 各渠道 Launcher API 配置（对应 archive 项目 src/utils/config.ts / constants.ts）
const REGIONS = {
  cn: {
    apiBase: 'https://launcher.hypergryph.com/api', // launcherCN
    appCode: '6LL0KJuqHBVz33WK', // game.cnWinRel
    launcherAppCode: 'abYeZZ16BPluCFyT', // launcher.cnWinRel
    channel: 1,
    subChannel: 1,
    launcherSubChannel: 1,
  },
  os: {
    apiBase: 'https://launcher.gryphline.com/api', // launcher
    appCode: 'YDUTE5gscDZ229CW', // game.osWinRel
    launcherAppCode: 'TiaytKBUIEdoEwRT', // launcher.osWinRel
    channel: 6,
    subChannel: 6,
    launcherSubChannel: 6,
  },
};

// 基准目录：pkg 打包后 process.execPath 指向 run.exe 的真实位置；node 直跑时为脚本所在目录
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const DEFAULT_CLI = path.join(BASE_DIR, 'tools', 'AnimeStudio.CLI', 'AnimeStudio.CLI.exe');
const CLI_ZIP = path.join(BASE_DIR, 'tools', 'AnimeStudio.CLI', 'AnimeStudio.CLI.zip');

// ---------- 参数解析 ----------
function argValue(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const REGION = argValue('--region', 'cn');
const REGION_CFG = REGIONS[REGION] ?? REGIONS.cn;
let BASE_URL = argValue('--base', null); // 为空则运行时动态获取
const WORK_DIR = path.resolve(BASE_DIR, argValue('--work', 'work'));
const OUT_DIR = path.resolve(BASE_DIR, argValue('--out', 'output'));
const CLI_EXE = argValue('--cli', DEFAULT_CLI);
const ARCHIVE_DIR = argValue('--archive-dir', null); // archive 分支 checkout 目录（可选）
const FORCE = process.argv.includes('--force'); // 强制重跑，绕过 archive 已存在检查
const SUMMARY_LANG = argValue('--lang', 'CN'); // 活动简化 JSON 语言
const NO_SUMMARY = process.argv.includes('--no-summary'); // 关闭活动简化 JSON 生成

let GAME_VERSION = null; // get_latest 返回的大版本（如 1.4）

// ---------- 网络工具 ----------
async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} -> ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} -> ${url}`);
  return res.json();
}

// ---------- 加密/解密 ----------
/** 对应 archive 项目 src/utils/cipher.ts 的 processVigenere(..., false) */
function vigenereDecrypt(data, key) {
  const keyBytes = Buffer.from(key, 'utf-8');
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = (data[i] - keyBytes[i % keyBytes.length] + 256) % 256;
  }
  return out;
}

/**
 * 运行时动态获取最新资源 base URL。
 * 链路：get_latest（取版本 + rand_str）-> get_latest_resources（取 resources[].path）
 * 对应 archive 项目 src/utils/api/akEndfield/launcher.ts 的 latestGame / latestGameResources。
 */
async function resolveLatestBaseUrl() {
  const qs = (obj) => new URLSearchParams(obj).toString();
  const { apiBase, appCode, launcherAppCode, channel, subChannel, launcherSubChannel } = REGION_CFG;

  // 1) get_latest：拿最新版本号 + pkg.file_path
  const latestUrl =
    `${apiBase}/game/get_latest?` +
    qs({
      appcode: appCode,
      launcher_appcode: launcherAppCode,
      channel,
      sub_channel: subChannel,
      launcher_sub_channel: launcherSubChannel,
      disk_type: 0, // 0=SSD 快
      patch_encrypt: 'true',
    });
  console.log(`      请求 get_latest: ${latestUrl}`);
  const latest = await getJson(latestUrl);
  if (!latest.pkg?.file_path) throw new Error(`get_latest 响应缺少 pkg.file_path（region=${REGION}）`);
  const version = latest.version;
  // 从 file_path（形如 .../1.4.4_<rand>/packs/...）提取 rand_str
  const randMatch = /_([^/]+)\/.+?$/.exec(latest.pkg.file_path);
  if (!randMatch) throw new Error(`无法从 pkg.file_path 提取 rand_str: ${latest.pkg.file_path}`);
  const randStr = randMatch[1];
  GAME_VERSION = version.split('.').slice(0, 2).join('.'); // 1.4.5 -> 1.4
  console.log(`      最新版本 v${version} (game_version=${GAME_VERSION}), rand_str=${randStr}`);

  // 2) get_latest_resources：拿 resources[].path
  const resUrl =
    `${apiBase}/game/get_latest_resources?` +
    qs({
      appcode: appCode,
      game_version: GAME_VERSION,
      version,
      platform: 'Windows',
      rand_str: randStr,
    });
  console.log(`      请求 get_latest_resources: ${resUrl}`);
  const resInfo = await getJson(resUrl);
  const main = (resInfo.resources || []).find((r) => r.name === 'main');
  if (!main?.path) throw new Error(`get_latest_resources 响应缺少 main 资源路径`);
  console.log(`      资源目录 (main): ${main.path}`);
  return main.path.replace(/\/+$/, '');
}

// ---------- 索引 / 版本 ----------
/** 下载 index_main.json 并用 Vigenère 解密，返回 JSON 对象 */
async function fetchAndDecryptIndex() {
  const encUrl = `${BASE_URL}/index_main.json`;
  console.log(`[Step 3/7] 下载索引: ${encUrl}`);
  const encBytes = await download(encUrl);

  const encText = encBytes.toString('utf-8').trim();
  const rawBytes = Buffer.from(encText, 'base64');
  console.log(`          原始 Base64 长度=${encText.length}, 解码字节=${rawBytes.length}`);

  const decBytes = vigenereDecrypt(rawBytes, RES_INDEX_KEY);
  const decText = decBytes.toString('utf-8');

  await mkdir(WORK_DIR, { recursive: true });
  const decPath = path.join(WORK_DIR, 'index_main_dec.json');
  await writeFile(decPath, decText, 'utf-8');
  console.log(`          解密索引已写入: ${decPath}`);

  return JSON.parse(decText);
}

/** 从 base URL 提取 大版本(ver) 与 小版本(fullVersionId) */
function extractVersionInfo() {
  // base 形如 https://.../{ver}/resource/Windows/main/{fullVersionId}/files
  const mainMatch = /\/main\/([^/]+)\/files$/i.exec(BASE_URL);
  const fullVersionId = mainMatch ? mainMatch[1] : null;
  const verMatch = /\/(\d+\.\d+)\/resource\//i.exec(BASE_URL);
  const ver = (verMatch ? verMatch[1] : null) || GAME_VERSION;
  if (!fullVersionId) {
    console.warn(`[warn] 无法从 base URL 提取 fullVersionId: ${BASE_URL}（将跳过 archive 去重检查）`);
  }
  return { fullVersionId, ver };
}

/** archive 归档目录：table/{region}/{ver}/{fullVersionId}/ */
function archiveTableDir(ver, fullVersionId) {
  return path.join(ARCHIVE_DIR, 'table', REGION, ver, fullVersionId);
}

/** 判断 archive 分支是否已有该版本（目录存在且含 .json 即视为已归档） */
async function alreadyArchived(ver, fullVersionId) {
  if (!ARCHIVE_DIR || !fullVersionId) return false;
  const dir = archiveTableDir(ver, fullVersionId);
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.toLowerCase().endsWith('.json')).length > 0;
  } catch {
    return false; // 目录不存在 -> 需要更新
  }
}

// ---------- Table 块下载 ----------
/** 从索引中筛出 Table 块文件（name 以 VFS/42A8FCA6/ 开头） */
function selectTableFiles(index) {
  const files = index.files.filter((f) => f.name.startsWith(`VFS/${BLOCK_DIR}/`));
  const blc = files.filter((f) => f.name.endsWith('.blc'));
  const chks = files.filter((f) => f.name.endsWith('.chk'));
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  return { files, blc, chks, totalBytes };
}

/** 并发受限下载器 */
async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 下载 Table 块的所有文件到 work/VFS/42A8FCA6/ */
async function downloadTableFiles(tableFiles) {
  const dir = path.join(WORK_DIR, 'VFS', BLOCK_DIR);
  await mkdir(dir, { recursive: true });
  const totalMB = (tableFiles.reduce((s, f) => s + (f.size || 0), 0) / 1048576).toFixed(1);
  console.log(`[Step 4/7] 下载 Table 块 (${tableFiles.length} 个文件, 合计 ${totalMB} MB) -> ${dir}`);

  let done = 0;
  let skipped = 0;
  let failed = 0;
  await mapLimit(tableFiles, CONCURRENCY, async (f) => {
    const rel = f.name.replace(/^VFS\//, '');
    const dest = path.join(dir, path.basename(rel));
    if (await fileExists(dest)) {
      skipped++;
      return;
    }
    const url = `${BASE_URL}/${f.name}`;
    try {
      const buf = await download(url);
      await writeFile(dest, buf);
      done++;
    } catch (e) {
      failed++;
      console.error(`          ✗ 下载失败 ${f.name}: ${e.message}`);
    }
    if ((done + skipped) % 20 === 0 || done + skipped === tableFiles.length) {
      console.log(`          进度: 完成 ${done + skipped}/${tableFiles.length} (新下载 ${done}, 已存在 ${skipped}, 失败 ${failed})`);
    }
  });
  console.log(`          下载完成: 新下载 ${done}, 已存在 ${skipped}, 失败 ${failed}`);
  return { done, skipped, failed };
}

// ---------- 解包工具（自包含） ----------

/**
 * 确保 AnimeStudio.CLI.exe 可用：
 * 仓库里存放的是自包含版的 zip（约 38MB，免 .NET 运行时），
 * 首次运行时若 exe 不存在则自动解压（Windows 用 PowerShell Expand-Archive）。
 */
async function ensureCli() {
  if (await fileExists(CLI_EXE)) return;
  if (!fs.existsSync(CLI_ZIP)) {
    throw new Error(`CLI 与压缩包都不存在: ${CLI_EXE}（请确认 tools/AnimeStudio.CLI/ 完整）`);
  }
  console.log(`[tools] 首次运行，解压自包含 CLI: ${CLI_ZIP}`);
  if (process.platform !== 'win32') {
    throw new Error('自包含 CLI 为 win-x64 构建，仅支持 Windows（请手动解压 AnimeStudio.CLI.zip 到 tools/AnimeStudio.CLI/）');
  }
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${CLI_ZIP}' -DestinationPath '${path.dirname(CLI_EXE)}' -Force`], {
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  if (r.status !== 0 || !(await fileExists(CLI_EXE))) {
    throw new Error('解压 AnimeStudio.CLI.zip 失败，请手动解压到 tools/AnimeStudio.CLI/');
  }
}

/** 调用自包含 AnimeStudio.CLI dump 提取 table（SparkBuffer -> JSON） */
async function runDump() {
  await ensureCli();
  console.log(`[Step 5/7] 调用 CLI: ${CLI_EXE}`);
  console.log(`          dump -s ${WORK_DIR} -o ${OUT_DIR} -b table`);
  const r = spawnSync(CLI_EXE, ['dump', '-s', WORK_DIR, '-o', OUT_DIR, '-b', 'table'], {
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    throw new Error(`AnimeStudio.CLI 退出码 ${r.status}（请确认 tools/AnimeStudio.CLI/AnimeStudio.CLI.exe 完整）`);
  }
}

// ---------- archive 同步 ----------
/** 复制 output/Table -> {archive-dir}/table/{region}/{ver}/{fullVersionId}/ */
async function syncToArchive(ver, fullVersionId) {
  if (!ARCHIVE_DIR || !fullVersionId) return false;
  const src = path.join(OUT_DIR, 'Table');
  const dst = archiveTableDir(ver, fullVersionId);
  await mkdir(dst, { recursive: true });
  let copied = 0;
  for (const f of await readdir(src)) {
    if (f.toLowerCase().endsWith('.json')) {
      await copyFile(path.join(src, f), path.join(dst, f));
      copied++;
    }
  }
  console.log(`[Step 6/7] 已同步 ${copied} 个 table JSON -> ${dst}`);
  return copied > 0;
}

// ---------- 活动简化 JSON ----------
/**
 * 用刚解包的 Table 生成活动聚合 JSON，写到 archive 分支根目录（每次更新覆盖）。
 * 逻辑与 activity-summary/activity-summary.mjs 一致（CJS 版 activity-summary.cjs）。
 */
async function syncSummaryToArchive() {
  if (!ARCHIVE_DIR || NO_SUMMARY) return false;
  const tableDir = path.join(OUT_DIR, 'Table');
  const outFile = path.join(ARCHIVE_DIR, 'activity-summary.json');
  if (!fs.existsSync(tableDir)) {
    console.warn('[Step 7/7] 跳过活动简化 JSON：Table 目录不存在 ' + tableDir);
    return false;
  }
  const summary = require('./activity-summary.cjs');
  console.log(`[Step 7/7] 生成活动简化 JSON (lang=${SUMMARY_LANG}) -> ${outFile}`);
  const result = summary.buildSummaryFile(tableDir, outFile, { lang: SUMMARY_LANG });
  console.log(`          活动数: ${result.meta.activityCount}, 警告: ${result.meta.warnings.length} 条`);
  return true;
}

// ---------- 主流程 ----------
async function main() {
  console.log('==============================================');
  console.log(` 终末地 Table 提取工作流  (region=${REGION})`);
  console.log('==============================================');

  // Step 1: 解析 base URL 与版本
  if (!BASE_URL) {
    console.log('[Step 1/7] 动态解析最新资源...');
    BASE_URL = await resolveLatestBaseUrl();
  } else {
    console.log(`[Step 1/7] 使用 --base: ${BASE_URL}`);
  }
  const { fullVersionId, ver } = extractVersionInfo();
  console.log(`          大版本(ver)=${ver ?? '(未知)'}, 小版本(fullVersionId)=${fullVersionId ?? '(未知)'}`);

  // Step 2: archive 已存在检查（跳过去重）
  if (!FORCE && (await alreadyArchived(ver, fullVersionId))) {
    console.log(`[Step 2/7] archive 已存在该版本: ${archiveTableDir(ver, fullVersionId)}`);
    console.log('          跳过下载与提取，本次无更新。');
    return false;
  }
  console.log(`[Step 2/7] ${FORCE ? '强制模式(--force)，' : ''}archive 中不存在该版本，开始提取...`);

  // Step 3: 下载并解密索引
  const index = await fetchAndDecryptIndex();
  const sel = selectTableFiles(index);
  console.log(
    `          Table 块: blc=${sel.blc.length}, chk=${sel.chks.length}, 总文件=${sel.files.length}, 总大小=${(sel.totalBytes / 1048576).toFixed(1)} MB`,
  );
  if (sel.files.length === 0) {
    throw new Error(`未找到 Table 块 (VFS/${BLOCK_DIR}/)，请检查资源版本。`);
  }

  // Step 4: 下载 Table 块
  await downloadTableFiles(sel.files);

  // Step 5: CLI 提取（自包含，免 .NET）
  await runDump();

  // Step 6: 同步到 archive 目录
  if (ARCHIVE_DIR && fullVersionId) {
    await syncToArchive(ver, fullVersionId);
  } else {
    console.log(`[Step 6/7] 未指定 --archive-dir（或无法解析版本），成品保留在 ${OUT_DIR}/Table`);
  }

  // Step 7: 生成活动简化 JSON 到 archive 根目录（每次更新覆盖）
  if (ARCHIVE_DIR) {
    await syncSummaryToArchive();
  } else {
    console.log('[Step 7/7] 未指定 --archive-dir，跳过活动简化 JSON（可手动运行 activity-summary.cjs）');
  }
  return true;
}

main()
  .then((updated) => {
    console.log(updated ? '\n完成：本次有更新。' : '\n完成：无更新。');
    process.exit(0);
  })
  .catch((e) => {
    console.error(`\n错误: ${e.message}`);
    process.exit(1);
  });
