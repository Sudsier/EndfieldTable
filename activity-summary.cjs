#!/usr/bin/env node
/**
 * activity-summary.cjs — 《明日方舟：终末地》活动聚合（甘特图数据源）【CJS 版，供 pkg 打包】
 *
 * 由 activity-summary/activity-summary.mjs 转换而来（import/export -> require/module.exports），
 * 供 workflow/run.cjs 在解包后生成精简 JSON。功能与 mjs 版完全一致，另提供
 * buildSummaryFile(tableDir, outFile, options) 一键「加载 -> 构建 -> 写文件」。
 *
 * 直接运行（作为 CLI）：
 *   node workflow/activity-summary.cjs --table-dir test/output/Table --out out.json
 *
 * 依赖：Node.js >= 18，零第三方包。
 */
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

// ---------- 无损 JSON 解析 ----------

/**
 * 无损解析：把 JSON 中所有 >=17 位的整数字面量改写为字符串后再 parse。
 * 游戏表的 i18n key 是 19 位大整数（如 3857077027067012521），超过
 * Number.MAX_SAFE_INTEGER，直接 JSON.parse 会丢精度导致查不到中文。
 * 扫描器会跳过字符串内部，因此不会误伤 "text": "12345678901234567890" 这类内容。
 */
function losslessParse(text) {
  const out = [];
  let i = 0;
  let inStr = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inStr) {
      out.push(ch);
      if (ch === '\\' && i + 1 < n) {
        out.push(text[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out.push(ch);
      i++;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const m = /^-?\d{17,}/.exec(text.slice(i));
      if (m) {
        out.push('"', m[0], '"');
        i += m[0].length;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return JSON.parse(out.join(''));
}

// ---------- 工具 ----------

function argValue(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readTableLossless(file) {
  return losslessParse(readFileSync(file, 'utf8'));
}

function tablePath(tableDir, name) {
  return path.join(tableDir, name);
}

/**
 * 解析游戏时间字符串 "2026/7/23 4:00:00" 为 epoch 毫秒。
 * 游戏时间为服务器本地时间（国服默认 UTC+8），tzOffsetMinutes 用于换算。
 */
function parseGameTime(str, tzOffsetMinutes) {
  if (!str) return null;
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?: (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(str.trim());
  if (!m) return null;
  const [, y, mo, d, h = 0, mi = 0, s = 0] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - tzOffsetMinutes * 60000;
}

/** 解析 "--tz +08:00" / "--tz 8" / "--tz UTC+8" 为分钟数 */
function parseTzOffset(arg) {
  const m = /([+-]?)(\d{1,2})(?::(\d{2}))?/.exec(arg);
  if (!m) return 480;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (+m[2] * 60 + (+(m[3] ?? 0)));
}

// ---------- 加载 ----------

/** 探测 Table 目录：优先显式指定，其次 test/output/Table、output/Table（相对当前工作目录） */
function detectTableDir(explicit) {
  if (explicit) return path.resolve(explicit);
  for (const p of ['test/output/Table', 'output/Table', 'work/output/Table']) {
    const abs = path.resolve(p);
    if (existsSync(abs)) return abs;
  }
  throw new Error('未找到 Table 目录，请用 --table-dir 指定（如 test/output/Table）');
}

/** 加载核心表 + 可选表（不存在的表返回 null，由调用方决定是否必需） */
function loadTables(tableDir, lang, withRewards, withItemNames) {
  const need = (name) => {
    const p = tablePath(tableDir, name);
    return existsSync(p) ? readTableLossless(p) : null;
  };
  const tables = {
    activity: need('ActivityTable.json'),
    timeRange: need('TimeRangeTable.json'),
    i18n: readJson(tablePath(tableDir, `I18nTextTable_${lang}.json`)),
    reward: withRewards ? need('RewardTable.json') : null,
    item: withRewards && withItemNames ? need('ItemTable.json') : null,
    instructionBook: need('InstructionBook.json'),
  };
  if (!tables.activity) throw new Error(`缺少 ActivityTable.json: ${tableDir}`);
  if (!tables.i18n) throw new Error(`缺少 I18nTextTable_${lang}.json: ${tableDir}`);
  return tables;
}

// ---------- i18n / 文本 ----------

/** 文本对象 {id, text} -> i18n 中文；查不到时回退原 text 字段 */
function textOf(obj, i18n) {
  if (!obj) return '';
  const t = obj.id != null ? i18n[String(obj.id)] : undefined;
  if (t != null) return t;
  return obj.text ?? '';
}

// ---------- 时间 ----------

/** 解析一个 timeId 对应的起止时间：多时间段只聚合最早开 / 最晚关（不保留原始时间数组） */
function resolveTime(timeId, timeRangeTable, tzOffsetMinutes) {
  if (!timeId) return null;
  const entry = timeRangeTable?.[timeId];
  if (!entry?.timeRangeList?.length) return null;
  const openMsList = entry.timeRangeList.map((r) => parseGameTime(r.openTime, tzOffsetMinutes)).filter((v) => v != null);
  const closeMsList = entry.timeRangeList.map((r) => parseGameTime(r.closeTime, tzOffsetMinutes)).filter((v) => v != null);
  const startMs = openMsList.length ? Math.min(...openMsList) : null;
  const endMs = closeMsList.length ? Math.max(...closeMsList) : null;
  const start =
    startMs != null
      ? entry.timeRangeList.find((r) => parseGameTime(r.openTime, tzOffsetMinutes) === startMs)?.openTime ?? null
      : null;
  const end =
    endMs != null
      ? entry.timeRangeList.find((r) => parseGameTime(r.closeTime, tzOffsetMinutes) === endMs)?.closeTime ?? null
      : null;
  return {
    start,
    startMs,
    end,
    endMs,
    permanent: entry.timeRangeList.some((r) => parseGameTime(r.closeTime, tzOffsetMinutes) == null),
  };
}

// ---------- 活动条目简化 ----------

function simplifyParameter(p) {
  const out = {};
  for (const k of ['valueStringList', 'valueIntList', 'valueFloatList', 'valueBoolList']) {
    if (p?.[k]?.length) {
      out[k] =
        k === 'valueFloatList'
          ? p[k].map((f) => (Number.isFinite(f) ? Number(f.toFixed(4)) : f))
          : p[k];
    }
  }
  return out;
}

function simplifyCondition(c, i18n) {
  const desc = textOf(c.desc, i18n);
  const tips = textOf(c.tips, i18n);
  const out = { conditionId: c.conditionId, desc, tips };
  // desc/tips 都为空时保留原始参数，否则对展示无用
  if (!desc && !tips) {
    const parameters = (c.parameters ?? []).map(simplifyParameter).filter((p) => Object.keys(p).length > 0);
    if (parameters.length) out.parameters = parameters;
  }
  return out;
}

function simplifyStage(s, i18n, time, rewardStrList) {
  const out = {
    stageId: s.stageId,
    name: textOf(s.name, i18n),
    time,
    rewards: rewardStrList ?? [],
  };
  const desc = textOf(s.desc, i18n);
  if (desc) out.desc = desc;
  return out;
}

// ---------- 关卡来源注册表（可按需扩展） ----------

/**
 * 分段关卡表：不同活动类型的关卡散落在各自的 Activity*Stage* 表里，
 * 结构不统一，用注册表声明如何按 activityId 取出 stage 列表。
 * extract(table) 返回 Map<activityId, stage[]>
 */
const STAGE_SOURCES = [
  {
    file: 'ActivityConditionalMultiStageTable.json',
    // 顶层: activityId -> { stageList: { stageId: {...} } }
    extract(table) {
      const out = new Map();
      for (const [activityId, entry] of Object.entries(table)) {
        const stages = entry?.stageList ? Object.values(entry.stageList) : [];
        if (stages.length) out.set(activityId, stages);
      }
      return out;
    },
  },
  {
    file: 'ActivityVersionGuideStageTable.json',
    // 顶层: { stageList: [ { activityId, stageId, ... }, ... ] }
    extract(table) {
      const out = new Map();
      for (const s of table?.stageList ?? []) {
        if (!s?.activityId || !s.stageId) continue;
        if (!out.has(s.activityId)) out.set(s.activityId, []);
        out.get(s.activityId).push(s);
      }
      return out;
    },
  },
];

/**
 * 关卡描述补全来源：主关卡表里不少关卡 desc.id==0（无描述），
 * 但各活动类型自己的关卡表里有描述性字段（如"提交XX食物"、"完成XX"），
 * 按 stageId 查出后填入 desc。collect(table) 返回 Map<stageId, 条目>，
 * 按 fields 顺序取第一个能解析出文本的字段。
 */
const STAGE_DESC_SOURCES = [
  {
    file: 'ActivitySubmitFoodTable.json',
    fields: ['submitDesc', 'noteDesc'],
    collect(table) {
      return new Map(Object.entries(table));
    },
  },
  {
    file: 'ActivitySnapshotChallengeTable.json',
    fields: ['normalStoryDesc', 'completeStoryDesc'],
    collect(table) {
      return new Map(Object.entries(table));
    },
  },
  {
    file: 'ActivityLimitedFormulaTable.json',
    // 顶层: activityId -> { activityStageList: { stageId: {...} } }
    fields: ['completeDesc', 'completeTips'],
    collect(table) {
      const out = new Map();
      for (const entry of Object.values(table)) {
        for (const [stageId, stage] of Object.entries(entry?.activityStageList ?? {})) out.set(stageId, stage);
      }
      return out;
    },
  },
  {
    file: 'ActivityCultivationRefundStageTable.json',
    fields: ['name'],
    collect(table) {
      return new Map(Object.entries(table));
    },
  },
];

/** 加载并收集所有 desc 补全来源，返回 [{ entries: Map<stageId, 条目>, fields }] */
function loadStageDescMaps(stageDescTables, i18n) {
  const maps = [];
  for (const src of STAGE_DESC_SOURCES) {
    const table = stageDescTables[src.file];
    if (!table) continue;
    maps.push({ entries: src.collect(table), fields: src.fields });
  }
  return maps;
}

/** stage 原生 desc 为空时，按类型表补全："这个关卡到底是什么" */
function enrichStageDesc(stageId, desc, descMaps, i18n) {
  if (desc) return desc;
  for (const { entries, fields } of descMaps) {
    const entry = entries.get(stageId);
    if (!entry) continue;
    for (const f of fields) {
      const t = textOf(entry[f], i18n);
      if (t) return t;
    }
  }
  return '';
}

/** 合并所有关卡来源，按 stageId 去重（靠前的来源优先，如更完整的 ConditionalMultiStage） */
function collectStages(stageTables, stageDescMaps, i18n, timeRangeTable, rewardTable, itemTable, tzOffsetMinutes, withItemNames) {
  const byActivity = new Map();
  const seen = new Set();
  const loaded = [];
  for (const src of STAGE_SOURCES) {
    const table = stageTables[src.file];
    if (!table) continue;
    loaded.push(src.file);
    for (const [activityId, stages] of src.extract(table)) {
      // 原始顺序即 sortId 顺序（表内已按 sortId 排列）；先按 sortId 稳定排序
      const ordered = [...stages].sort((a, b) => (a.sortId ?? 0) - (b.sortId ?? 0));
      for (const s of ordered) {
        if (!s?.stageId || seen.has(s.stageId)) continue;
        seen.add(s.stageId);
        const time = resolveTime(s.timeId, timeRangeTable, tzOffsetMinutes);
        const rewards = rewardTable ? resolveRewards(s.rewardId, rewardTable, itemTable, i18n, withItemNames) : [];
        const simplified = simplifyStage(s, i18n, time, rewards);
        if (!simplified.desc) {
          const enriched = enrichStageDesc(s.stageId, '', stageDescMaps, i18n);
          // 与关卡名相同的文本不重复写入 desc
          if (enriched && enriched !== simplified.name) simplified.desc = enriched;
        }
        // 过滤完全无信息的关卡（无名、无描述、无奖励、无时间）
        if (!simplified.name && !simplified.desc && !simplified.rewards.length && !simplified.time) continue;
        if (!byActivity.has(activityId)) byActivity.set(activityId, []);
        byActivity.get(activityId).push(simplified);
      }
    }
  }
  return { byActivity, loaded };
}

// ---------- 奖励 ----------

/**
 * rewardId -> RewardTable.itemBundles，输出 "物品名×数量" 字符串数组。
 * 物品名经 ItemTable.name -> i18n 解析；解析不到时回退原始物品 id。
 */
function resolveRewards(rewardId, rewardTable, itemTable, i18n, withItemNames) {
  if (!rewardId) return null;
  const entry = rewardTable?.[rewardId];
  if (!entry) return [];
  return (entry.itemBundles ?? []).map((b) => {
    const item = withItemNames && itemTable ? itemTable[b.id] : null;
    const name = item?.name ? textOf(item.name, i18n) : null;
    return `${name ?? b.id}×${b.count}`;
  });
}

// ---------- 主构建（纯函数，便于后续接 HTTP 接口） ----------

/**
 * 聚合活动数据。
 * @param {object} tables 已加载的表
 *   { activity, timeRange?, i18n, reward?, item?, instructionBook?, stageTables?, stageDescTables? }
 *   stageTables:     Map<文件名, 已解析的关卡表对象>（STAGE_SOURCES）
 *   stageDescTables: Map<文件名, 已解析的关卡描述表对象>（STAGE_DESC_SOURCES）
 * @param {object} options { tzOffsetMinutes, withRewards, withItemNames, withStages, lang }
 * @returns {{ meta: object, activities: object[] }}
 */
function buildActivitySummary(tables, options = {}) {
  const {
    tzOffsetMinutes = 480,
    withRewards = true,
    withItemNames = true,
    withStages = true,
    lang = 'CN',
  } = options;
  const { activity, timeRange, i18n, reward, item, instructionBook, stageTables = {}, stageDescTables = {} } = tables;

  const warnings = [];

  const stageDescMaps = withStages ? loadStageDescMaps(stageDescTables, i18n) : [];

  const stageCtx = withStages
    ? collectStages(stageTables, stageDescMaps, i18n, timeRange, reward, item, tzOffsetMinutes, withItemNames)
    : { byActivity: new Map(), loaded: [] };

  const activities = Object.entries(activity)
    .map(([id, a]) => ({ id, a, sortKey: a.sortId ?? Infinity }))
    .sort((x, y) => x.sortKey - y.sortKey)
    .map(({ id, a }) => {
      const rewards = withRewards ? resolveRewards(a.rewardId, reward, item, i18n, withItemNames) ?? [] : undefined;
      // 活动说明：instructionId -> InstructionBook.content（含接取条件/活动规则），原文输出
      const instruction = textOf(instructionBook?.[a.instructionId]?.content, i18n);

      const out = {
        id,
        name: textOf(a.name, i18n),
        desc: textOf(a.desc, i18n),
        instruction,
        time: resolveTime(a.timeId, timeRange, tzOffsetMinutes),
        conditions: (a.conditions ?? []).map((c) => simplifyCondition(c, i18n)),
        rewards,
      };
      if (withStages) out.stages = stageCtx.byActivity.get(id) ?? [];

      if (!out.name) warnings.push(`活动 ${id} 名称在 i18n 中缺失 (name.id=${a.name?.id})`);
      if (!out.time) warnings.push(`活动 ${id} 无时间段 (timeId=${a.timeId ?? '(空)'})`);
      if (!out.instruction) warnings.push(`活动 ${id} 无说明 (instructionId=${a.instructionId ?? '(空)'})`);
      return out;
    });

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      lang,
      timezoneOffsetMinutes: tzOffsetMinutes,
      activityCount: activities.length,
      withRewards,
      withItemNames,
      withStages,
      stageTablesLoaded: stageCtx.loaded,
      stageDescTablesLoaded: STAGE_DESC_SOURCES.filter((s) => stageDescTables[s.file]).map((s) => s.file),
      warnings,
    },
    activities,
  };
}

/**
 * 一键式：加载 Table 目录 -> 构建 -> 写入 outFile。
 * @param {string} tableDir Table 目录（含 ActivityTable.json 等）
 * @param {string} outFile 输出 JSON 路径
 * @param {object} options 同 buildActivitySummary + { lang }
 * @returns {object} buildActivitySummary 的结果
 */
function buildSummaryFile(tableDir, outFile, options = {}) {
  const { lang = 'CN', tzOffsetMinutes = 480, withRewards = true, withItemNames = true, withStages = true } = options;

  const tables = loadTables(tableDir, lang, withRewards, withItemNames);

  // 关卡表按 STAGE_SOURCES 声明按需加载
  if (withStages) {
    tables.stageTables = {};
    for (const src of STAGE_SOURCES) {
      const p = tablePath(tableDir, src.file);
      if (existsSync(p)) tables.stageTables[src.file] = readTableLossless(p);
    }
    // 关卡描述补全表按 STAGE_DESC_SOURCES 声明按需加载
    tables.stageDescTables = {};
    for (const src of STAGE_DESC_SOURCES) {
      const p = tablePath(tableDir, src.file);
      if (existsSync(p)) tables.stageDescTables[src.file] = readTableLossless(p);
    }
  }

  const result = buildActivitySummary(tables, { lang, tzOffsetMinutes, withRewards, withItemNames, withStages });

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf-8');
  return result;
}

module.exports = {
  losslessParse,
  parseGameTime,
  resolveTime,
  buildActivitySummary,
  buildSummaryFile,
};

// ---------- CLI（直接运行本文件时） ----------

function main() {
  const tableDir = detectTableDir(argValue('--table-dir', null));
  const lang = argValue('--lang', 'CN');
  const outFile = path.resolve(argValue('--out', path.join(path.dirname(tableDir), 'activity-summary.json')));
  const tzOffsetMinutes = parseTzOffset(argValue('--tz', '+08:00'));
  const withRewards = !hasFlag('--no-rewards');
  const withItemNames = withRewards && !hasFlag('--no-item-names');
  const withStages = !hasFlag('--no-stages');

  console.log('==============================================');
  console.log(' 终末地 活动聚合 (activity-summary)');
  console.log('==============================================');
  console.log(`  Table 目录 : ${tableDir}`);
  console.log(`  语言       : ${lang}`);
  console.log(`  时区偏移   : ${tzOffsetMinutes} min`);

  const result = buildSummaryFile(tableDir, outFile, { lang, tzOffsetMinutes, withRewards, withItemNames, withStages });

  console.log(`  活动数     : ${result.meta.activityCount}`);
  console.log(`  关卡表     : ${result.meta.stageTablesLoaded.join(', ') || '(无)'}`);
  if (result.meta.warnings.length) {
    console.log(`  警告       : ${result.meta.warnings.length} 条`);
    for (const w of result.meta.warnings.slice(0, 10)) console.log(`    - ${w}`);
  }
  console.log(`  已输出     : ${outFile}`);
}

// CJS 下判断是否作为主入口
if (require.main === module) {
  main();
}
