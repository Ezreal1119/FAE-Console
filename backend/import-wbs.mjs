import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import ExcelJS from 'exceljs';
import { isAdmin } from './accounts.mjs';
import { backfillTaskCodes, insertHistoricalTask } from './records.mjs';
import { readDatabase } from './store.mjs';

const columns = {
  project: '项目', device: '设备类型', stage: '项目阶段', category: 'WBS任务',
  due: '计划时间', end: '完成时间', log: '任务日志状况', owner: '责任人', status: '完成'
};
const statuses = new Map([['完成', '已完成'], ['进行中', '开发中']]);
const deviceAliases = new Map([
  ['扫描手柄', '手柄'], ['扫码枪', '扫描枪'], ['座充', '座充与底座'], ['底座', '座充与底座'],
  ['PDA座充', '座充与底座'], ['穿戴', '穿戴设备'], ['指环', '穿戴设备'], ['手环', '穿戴设备']
]);
const stageAliases = new Map([['DVT2', 'DVT'], ['DVT 2', 'DVT'], ['PVT1', 'PVT'], ['PVT2', 'PVT']]);
const dayMillis = 86400000;
const maxWorkbookBytes = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const matchKey = text => text.normalize('NFKC').trim().toUpperCase();

function cellValue(value) {
  if (value == null || value instanceof Date || typeof value !== 'object') return value;
  if ('formula' in value || 'sharedFormula' in value) return cellValue(value.result);
  if (Array.isArray(value.richText)) return value.richText.map(part => part.text).join('');
  return typeof value.text === 'string' ? value.text : null;
}

function sourceText(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : '';
  return value == null ? '' : String(value).trim();
}

function optionalSource(value) {
  const text = sourceText(value);
  return /^(?:[\\/\\—-]+|N\/?A)$/iu.test(matchKey(text)) ? '' : text;
}

function findColumns(sheet, week) {
  const positions = new Map();
  sheet.getRow(2).eachCell((cell, index) => {
    const label = matchKey(sourceText(cellValue(cell.value)));
    if (!Object.values(columns).some(name => matchKey(name) === label)) return;
    if (positions.has(label)) throw new Error(sheet.name + ' 的表头重复：' + label);
    positions.set(label, index);
  });
  const result = Object.fromEntries(Object.entries(columns).map(([key, name]) => [key, positions.get(matchKey(name))]));
  const headerBlank = index => !sourceText(cellValue(sheet.getRow(2).getCell(index).value));
  if (week >= 43 && week <= 46 && !result.due && result.category === 5 && result.end === 7 && headerBlank(6)) result.due = 6;
  if (week === 42 && !result.owner && result.log === 8 && result.status === 10 && headerBlank(9)) result.owner = 9;
  const missing = Object.keys(columns).filter(key => !result[key]).map(key => columns[key]);
  if (missing.length) throw new Error(sheet.name + ' 缺少列：' + missing.join('、'));
  return result;
}

async function readWeeks(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes, {
    ignoreNodes: ['mergeCells', 'hyperlinks', 'conditionalFormatting', 'dataValidations', 'drawing', 'picture', 'tableParts']
  });
  const weeks = new Map();
  let emptyTitleRows = 0;
  for (const sheet of workbook.worksheets) {
    const match = /^WK(\d+)工程部任务明细$/iu.exec(sheet.name.trim());
    if (!match) continue;
    const week = Number(match[1]);
    if (weeks.has(week)) throw new Error('工作簿包含重复的周编号：WK' + week);
    const positions = findColumns(sheet, week);
    const rows = [];
    sheet.eachRow((row, number) => {
      if (number <= 2) return;
      const source = Object.fromEntries(Object.entries(positions).map(([key, index]) => [key, cellValue(row.getCell(index).value)]));
      if (!sourceText(source.log)) {
        if (Object.values(source).some(sourceText)) emptyTitleRows++;
        return;
      }
      rows.push({ week, sheet: sheet.name, row: number, source });
    });
    weeks.set(week, rows);
  }
  if (!weeks.size) throw new Error('没有找到工程部任务明细周表。');
  return { weeks, emptyTitleRows, date1904: workbook.properties.date1904 === true };
}

function dateOnly(year, month, day) {
  if (year < 1900 || year > 9999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : null;
}

function parseDate(value, date1904, yearHint) {
  if (value instanceof Date) return dateOnly(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  const text = matchKey(sourceText(value));
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text));
    if (serial < (date1904 ? 0 : 61) || serial > 2958465) return null;
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const date = new Date(epoch + serial * dayMillis);
    return dateOnly(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const full = /^(\d{4})(?:[./-]|年)(\d{1,2})(?:[./-]|月)(\d{1,2})日?$/.exec(text);
  if (full) return dateOnly(...full.slice(1).map(Number));
  const short = /^(\d{1,2})(?:[./-]|月)(\d{1,2})日?$/.exec(text);
  return short && yearHint ? dateOnly(yearHint, ...short.slice(1).map(Number)) : null;
}

function dominantYear(rows, date1904) {
  const counts = new Map();
  for (const { source } of rows) {
    for (const value of [source.due, source.end]) {
      const date = parseDate(value, date1904);
      if (!date) continue;
      const year = Number(date.slice(0, 4));
      counts.set(year, (counts.get(year) ?? 0) + 1);
    }
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return ranked[0] && ranked[0][1] !== ranked[1]?.[1] ? ranked[0][0] : null;
}

function projectKey(value) {
  const key = matchKey(value);
  const compact = key.replace(/\s+/g, '');
  return /^SQ\d+[A-Z0-9]*(?:-[A-Z0-9]+)?$/.test(compact) ? compact : key;
}

function configuredValue(source, options, key = matchKey, aliases) {
  const input = optionalSource(source);
  if (!input) return null;
  if (options.includes(input)) return input;
  const normalized = key(input);
  const target = aliases?.get(normalized) ?? normalized;
  const matches = options.filter(option => key(option) === key(target));
  return matches.length === 1 ? matches[0] : input;
}

function indexMembers(db) {
  const accounts = new Set(db.users.map(user => user.id));
  const names = new Map();
  for (const profile of db.profiles) {
    if (!accounts.has(profile.owner_id) || !sourceText(profile.display_name)) continue;
    const name = matchKey(profile.display_name);
    const matches = names.get(name) ?? new Map();
    matches.set(profile.owner_id, { id: profile.owner_id, name: profile.display_name });
    names.set(name, matches);
  }
  return names;
}

function requiredCatalog(db) {
  const catalog = db.demandOptions;
  const keys = ['proj', 'device_type', 'project_stage'];
  if (!keys.every(key => Array.isArray(catalog?.[key]))) throw new Error('数据库缺少基础配置选项，请先更新服务并启动一次。');
  return catalog;
}

function prepareImport(db, workbook, workbookId) {
  const catalog = requiredCatalog(db);
  const names = indexMembers(db);
  const previouslyImported = new Set(db.wbsImports?.[workbookId] ?? []);
  const allRows = [...workbook.weeks.values()].flat();
  const workbookYear = dominantYear(allRows, workbook.date1904);
  const seen = new Map();
  const report = [];
  const pending = [];
  const totals = { sheets: workbook.weeks.size, logs: allRows.length, emptyTitleRows: workbook.emptyTitleRows,
    ready: 0, duplicates: 0, alreadyImported: 0, missingOwner: 0, unknownOwner: 0, ambiguousOwner: 0, warnings: 0 };
  for (const [, rows] of [...workbook.weeks].sort(([a], [b]) => b - a)) {
    const year = dominantYear(rows, workbook.date1904) ?? workbookYear;
    const occurrences = new Map();
    for (const { sheet, row, source } of rows) {
      const entry = { sheet, row, owner: sourceText(source.owner), log: sourceText(source.log) };
      report.push(entry);
      const due = parseDate(source.due, workbook.date1904, year);
      const end = parseDate(source.end, workbook.date1904, year);
      const status = statuses.get(matchKey(sourceText(source.status))) ?? '待规划';
      const signature = JSON.stringify([source.project, source.device, source.stage, source.category, source.log, source.owner,
        due ?? source.due, end ?? source.end, source.status].map(sourceText));
      const occurrence = (occurrences.get(signature) ?? 0) + 1;
      occurrences.set(signature, occurrence);
      const id = hash(JSON.stringify([signature, occurrence]));
      const matched = names.get(matchKey(entry.owner));
      if (!entry.owner || matched?.size !== 1) {
        entry.result = !entry.owner ? 'missingOwner' : matched ? 'ambiguousOwner' : 'unknownOwner';
        totals[entry.result]++;
        continue;
      }
      if (seen.has(id)) {
        entry.result = 'duplicates';
        entry.duplicateOf = seen.get(id);
        totals.duplicates++;
        continue;
      }
      seen.set(id, { sheet, row });
      if (previouslyImported.has(id)) {
        entry.result = 'alreadyImported';
        totals.alreadyImported++;
        continue;
      }
      const member = matched.values().next().value;
      const fields = {
        desc: entry.log, status, due, end_time: end,
        proj: configuredValue(source.project, catalog.proj, projectKey),
        device_type: configuredValue(source.device, catalog.device_type, matchKey, deviceAliases),
        project_stage: configuredValue(source.stage, catalog.project_stage, matchKey, stageAliases)
      };
      const warnings = [];
      if (!due && optionalSource(source.due)) warnings.push('无法识别计划日期：' + sourceText(source.due));
      if (!end && optionalSource(source.end)) warnings.push('无法识别完成日期：' + sourceText(source.end));
      if (end && status !== '已完成') warnings.push('已填写完成日期，沿用原完成状态');
      if (optionalSource(source.status) && !statuses.has(matchKey(sourceText(source.status)))) {
        warnings.push('无法识别完成状态：' + sourceText(source.status));
      }
      if (warnings.length) totals.warnings++;
      entry.result = 'ready';
      entry.fields = fields;
      entry.warnings = warnings;
      pending.push({ id, member, fields });
    }
  }
  totals.ready = pending.length;
  return { totals, rows: report, pending };
}

async function writePrivateFile(path, document) {
  const target = resolve(path);
  const scratch = await mkdtemp(join(dirname(target), '.wbs-import-'));
  try {
    const file = join(scratch, 'result.json');
    await writeFile(file, JSON.stringify(document, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    await link(file, target);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const usage = [
  'node backend/import-wbs.mjs preview --file WBS.xlsx --db db.json --admin 账号 --report preview.json',
  'node backend/import-wbs.mjs apply --file WBS.xlsx --db db.json --admin 账号 --confirm 预览校验码 --output imported-db.json'
].join('\n');

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string' }, db: { type: 'string' }, admin: { type: 'string' },
      report: { type: 'string' }, output: { type: 'string' }, confirm: { type: 'string' }
    }
  });
  const mode = positionals[0];
  const required = mode === 'preview' ? ['report'] : mode === 'apply' ? ['confirm', 'output'] : null;
  if (positionals.length !== 1 || !required || !['file', 'db', 'admin', ...required].every(key => values[key])) throw new Error(usage);
  if (extname(values.file).toLowerCase() !== '.xlsx') throw new Error('请选择 .xlsx 工作簿。');
  const db = readDatabase(values.db);
  const admin = db.users.find(user => user.account === values.admin && isAdmin(user));
  if (!admin) throw new Error('请指定数据库中已有的管理员账号。');
  const bytes = await readFile(values.file);
  if (bytes.length > maxWorkbookBytes) throw new Error('工作簿不能超过 16 MB。');
  const workbookId = hash(bytes);
  const workbook = await readWeeks(bytes);
  const { totals, rows, pending } = prepareImport(db, workbook, workbookId);
  const confirm = hash(JSON.stringify({ workbookId, admin: admin.id, pending }));
  if (mode === 'preview') {
    await writePrivateFile(values.report, { workbookId, confirm, totals, rows });
    console.log(JSON.stringify({ ...totals, confirm }));
    return;
  }
  if (values.confirm !== confirm) throw new Error('预览校验码与当前导入结果不一致，请重新预览并确认。');
  if (!pending.length) {
    console.log(JSON.stringify({ ...totals, imported: 0 }));
    return;
  }
  const imports = (db.wbsImports ??= {});
  const imported = (imports[workbookId] ??= []);
  backfillTaskCodes(db);
  for (const item of pending.toReversed()) {
    insertHistoricalTask(db, admin, item.member, item.fields);
    imported.push(item.id);
  }
  await writePrivateFile(values.output, db);
  console.log(JSON.stringify({ ...totals, imported: pending.length }));
}

main().catch(error => {
  console.error(error.code === 'EEXIST' ? '输出文件已存在，请使用新的路径。' : error.message);
  process.exitCode = 1;
});
