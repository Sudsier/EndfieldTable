#!/usr/bin/env node
/**
 * run.mjs — 《明日方舟：终末地》Table 提取工作流（自包含版本）
 *
 * 完整流水线（默认国服）：
 *   1. 动态解析最新资源 base URL（get_latest -> get_latest_resources）
 *   2. 从 base URL 提取 大版本(ver) + 小版本(fullVersionId，如 9163343-11_UKLczw3HK1ELysvN)
 *   3. 若指定 --archive-dir 且 table/{region}/{ver}/{fullVersionId}/ 已存在 -> 跳过（无更新）
 *   4. 下载 index_main.json -> Base64 解码 + Vigenère 解密 -> index_main_dec.json
 *   5. 从索引筛出 Table 块（type=18 / VFS/42A8FCA6/）并发下载 blc + chk
 *   6. 调用预编译的 AnimeStudio.CLI dump -b table 提取 JSON 表格
 *   7. 复制 output/Table -> {archive-dir}/table/{region}/{ver}/{fullVersionId}/
 *
 * 用法：
 *   node run.mjs                                     # 默认国服：动态获取 + 下载 + 提取
 *   node run.mjs --archive-dir ./archive-data        # 额外同步成品到 archive 分支 checkout 目录（含跳过检查）
 *   node run.mjs --force                             # 强制重跑（绕过 archive 已存在检查）
 *   node run.mjs --region cn|os                      # 渠道：cn=国服(默认) / os=国际服
 *   node run.mjs --base <url>                        # 跳过动态获取，直接指定资源 base URL
 *   node run.mjs --work <dir> --out <dir> --cli <exe>
 *
 * 依赖：Node.js >= 18（内置 fetch，无需任何第三方包）。
 *       工具 AnimeStudio.CLI 为预编译产物，位于 tools/AnimeStudio.CLI/（framework-dependent，需 .NET 9 运行时）。
 */
import { mkdir, writeFile, access, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

// 脚本所在目录（workflow/）——工具、默认 work/output 均相对该目录定位，保证自包含
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = path.join(SCRIPT_DIR, 'tools', 'AnimeStudio.CLI', 'AnimeStudio.CLI.exe');

// ---------- 参数解析 ----------
function argValue(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const REGION = argValue('--region', 'cn');
const REGION_CFG = REGIONS[REGION] ?? REGIONS.cn;
let BASE_URL = argValue('--base', null); // 为空则运行时动态获取
const WORK_DIR = path.resolve(SCRIPT_DIR, argValue('--work', 'work'));
const OUT_DIR = path.resolve(SCRIPT_DIR, argValue('--out', 'output'));
const CLI_EXE = argValue('--cli', DEFAULT_CLI);
const ARCHIVE_DIR = argValue('--archive-dir', null); // archive 分支 checkout 目录（可选）
const FORCE = process.argv.includes('--force'); // 强制重跑，绕过 archive 已存在检查

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
  console.log(`[Step 3/6] 下载索引: ${encUrl}`);
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
  console.log(`[Step 4/6] 下载 Table 块 (${tableFiles.length} 个文件, 合计 ${totalMB} MB) -> ${dir}`);

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

// ---------- CLI 提取 ----------
/** 调用预编译 AnimeStudio.CLI dump 提取 table（SparkBuffer -> JSON） */
function runDump() {
  console.log(`[Step 5/6] 调用 CLI: ${CLI_EXE}`);
  console.log(`          dump -s ${WORK_DIR} -o ${OUT_DIR} -b table`);
  const r = spawnSync(CLI_EXE, ['dump', '-s', WORK_DIR, '-o', OUT_DIR, '-b', 'table'], {
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    throw new Error(`AnimeStudio.CLI 退出码 ${r.status}（请确认 tools/AnimeStudio.CLI 完整且 .NET 9 运行时可用）`);
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
  console.log(`[Step 6/6] 已同步 ${copied} 个 table JSON -> ${dst}`);
  return copied > 0;
}

// ---------- 主流程 ----------
async function main() {
  console.log('==============================================');
  console.log(` 终末地 Table 提取工作流  (region=${REGION})`);
  console.log('==============================================');

  // Step 1: 解析 base URL 与版本
  if (!BASE_URL) {
    console.log('[Step 1/6] 动态解析最新资源...');
    BASE_URL = await resolveLatestBaseUrl();
  } else {
    console.log(`[Step 1/6] 使用 --base: ${BASE_URL}`);
  }
  const { fullVersionId, ver } = extractVersionInfo();
  console.log(`          大版本(ver)=${ver ?? '(未知)'}, 小版本(fullVersionId)=${fullVersionId ?? '(未知)'}`);

  // Step 2: archive 已存在检查（跳过去重）
  if (!FORCE && (await alreadyArchived(ver, fullVersionId))) {
    console.log(`[Step 2/6] archive 已存在该版本: ${archiveTableDir(ver, fullVersionId)}`);
    console.log('          跳过下载与提取，本次无更新。');
    return false;
  }
  console.log(`[Step 2/6] ${FORCE ? '强制模式(--force)，' : ''}archive 中不存在该版本，开始提取...`);

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

  // Step 5: CLI 提取
  if (!(await fileExists(CLI_EXE))) {
    throw new Error(`CLI 不存在: ${CLI_EXE}（请确认 workflow/tools/AnimeStudio.CLI 完整）`);
  }
  runDump();

  // Step 6: 同步到 archive 目录
  if (ARCHIVE_DIR && fullVersionId) {
    await syncToArchive(ver, fullVersionId);
  } else {
    console.log(`[Step 6/6] 未指定 --archive-dir（或无法解析版本），成品保留在 ${OUT_DIR}/Table`);
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
