#!/usr/bin/env node
/**
 * build.mjs — 重新构建 workflow 的自包含产物（在仓库根目录执行）
 *
 * 产出：
 *   1. tools/AnimeStudio.CLI/AnimeStudio.CLI.zip   自包含解包工具（内置 .NET 运行时，免安装）
 *      （由 AnimeStudio/AnimeStudio.CLI 源码 dotnet publish 生成，单文件 + 原生库自解压）
 *   2. run.exe                                     主流程单文件可执行（pkg 打包，内置 Node 18 运行时）
 *
 * 用法：
 *   node workflow/build.mjs            # 一步完成 CLI 自包含打包 + pkg 打包
 *   node workflow/build.mjs --no-cli   # 只打包 run.exe（跳过 CLI 重新发布）
 *
 * 前置：本机需要 dotnet SDK 9.x 与 pkg（npm i -g pkg 或 npx pkg）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PUBLISH_OUT = path.join(SCRIPT_DIR, '.build', 'publish');
const CLI_DIR = path.join(SCRIPT_DIR, 'tools', 'AnimeStudio.CLI');
const CLI_EXE = path.join(CLI_DIR, 'AnimeStudio.CLI.exe');
const CLI_ZIP = path.join(CLI_DIR, 'AnimeStudio.CLI.zip');
const RUN_EXE = path.join(SCRIPT_DIR, 'run.exe');

const SKIP_CLI = process.argv.includes('--no-cli');

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf-8', ...opts });
  if (r.status !== 0) {
    throw new Error(`命令失败: ${cmd} ${args.join(' ')} (exit=${r.status})`);
  }
}

function zipFile(src, dest) {
  // 用 PowerShell Compress-Archive 压缩为 zip（zip 内仅一个 exe，无目录前缀）
  const ps = `Compress-Archive -LiteralPath '${src}' -DestinationPath '${dest}' -CompressionLevel Optimal -Force`;
  run('powershell', ['-NoProfile', '-Command', ps]);
}

// ---------- 1. 自包含 CLI ----------
if (!SKIP_CLI) {
  console.log('========== [1/2] 发布自包含 AnimeStudio.CLI (win-x64, 单文件) ==========');
  rmSync(PUBLISH_OUT, { recursive: true, force: true });
  mkdirSync(PUBLISH_OUT, { recursive: true });
  run('dotnet', [
    'publish',
    path.join(REPO_ROOT, 'AnimeStudio', 'AnimeStudio.CLI', 'AnimeStudio.CLI.csproj'),
    '-c', 'Release',
    '-r', 'win-x64',
    '--self-contained', 'true',
    '-f', 'net9.0-windows',
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-p:IncludeAllContentForSelfExtract=true',
    '-o', PUBLISH_OUT,
  ]);

  const publishedExe = path.join(PUBLISH_OUT, 'AnimeStudio.CLI.exe');
  if (!existsSync(publishedExe)) throw new Error('发布产物缺失: ' + publishedExe);
  const sizeMB = (statSync(publishedExe).size / 1048576).toFixed(1);
  console.log(`  自包含 exe: ${sizeMB} MB`);

  console.log('========== 压缩为 AnimeStudio.CLI.zip ==========');
  mkdirSync(CLI_DIR, { recursive: true });
  copyFileSync(publishedExe, CLI_EXE);
  zipFile(CLI_EXE, CLI_ZIP);
  rmSync(CLI_EXE, { force: true });
  rmSync(PUBLISH_OUT, { recursive: true, force: true });
  const zipMB = (statSync(CLI_ZIP).size / 1048576).toFixed(1);
  console.log(`  已生成: ${CLI_ZIP} (${zipMB} MB)`);
} else {
  console.log('========== [1/2] 跳过 CLI 重新发布 (--no-cli) ==========');
}

// ---------- 2. pkg 打包 run.cjs ----------
console.log('========== [2/2] pkg 打包 run.cjs -> run.exe ==========');
run('pkg', ['run.cjs', '-t', 'node18-win-x64', '-o', 'run.exe'], { cwd: SCRIPT_DIR });
const runMB = (statSync(RUN_EXE).size / 1048576).toFixed(1);
console.log(`  已生成: ${RUN_EXE} (${runMB} MB)`);

console.log('\n完成。部署时将 workflow 内容上传到仓库根目录：run.exe + tools/ + .github/');
