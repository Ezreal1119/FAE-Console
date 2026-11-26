import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { RequestError } from './store.mjs';

export const MEMBER_IMPORT_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_MEMBERS = 200;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024;
const COLUMN_KEYS = new Map([
  ['姓名', 'name'], ['工号', 'emp_no'], ['团队', 'team'], ['岗位', 'role'],
  ['状态', 'status'], ['联系方式', 'contact'], ['工作职责与技能', 'duty'], ['备注', 'remark']
]);

async function validateWorkbookArchive(buffer) {
  const zip = await yauzl.fromBufferPromise(buffer, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
  try {
    if (zip.entryCount > 256) throw new RequestError(400, '工作簿内容过多，请使用人员导入模板。');
    let expanded = 0;
    const names = new Set();
    for await (const entry of zip.eachEntry()) {
      expanded += entry.uncompressedSize;
      if (expanded > MAX_EXPANDED_BYTES) throw new RequestError(400, '工作簿解压后过大，请使用人员导入模板。');
      if (names.has(entry.fileName)) throw new RequestError(400, '工作簿包含重复文件，请重新另存为 .xlsx。');
      names.add(entry.fileName);
      if (entry.fileName.endsWith('/')) continue;
      // Read to EOF so yauzl checks the actual inflated length before ExcelJS opens it.
      const stream = await zip.openReadStreamPromise(entry);
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize) throw new RequestError(400, '工作簿内容无效。');
      }
    }
    if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml') ||
        [...names].some(name => /^xl\/vbaProject\.bin$/i.test(name))) {
      throw new RequestError(400, '请上传不含宏的 .xlsx 工作簿。');
    }
  } finally {
    zip.close();
  }
}

function cellValue(cell, key) {
  if (cell.value == null) return '';
  if (typeof cell.value === 'string' || cell.type === ExcelJS.ValueType.RichText) return cell.text.trim();
  if ((key === 'emp_no' || key === 'contact') && Number.isSafeInteger(cell.value) && cell.value >= 0) {
    const value = String(cell.value);
    return /^0{2,100}$/.test(cell.numFmt || '') ? value.padStart(cell.numFmt.length, '0') : value;
  }
  throw new RequestError(400, '请填写文本。公式请复制后粘贴为值。');
}

function readRows(sheet) {
  const columns = new Map();
  sheet.getRow(1).eachCell((cell, number) => {
    if (typeof cell.value !== 'string') return;
    const label = cell.value.trim();
    const key = COLUMN_KEYS.get(label);
    if (!key) return;
    if (columns.has(key)) throw new RequestError(422, '表头重复：' + label + '。');
    columns.set(key, { label, number });
  });
  if (!columns.has('name') || !columns.has('emp_no')) {
    throw new RequestError(422, '第 1 行须包含「姓名」和「工号」两列，请检查表头。');
  }

  const rows = [];
  const errors = [];
  let populatedRows = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const relevant = [...columns.values()].some(({ number }) => {
      const value = row.getCell(number).value;
      return value != null && (typeof value !== 'string' || value.trim() !== '');
    });
    if (!relevant) return;
    if (++populatedRows > MAX_MEMBERS) throw new RequestError(422, '一次最多导入 ' + MAX_MEMBERS + ' 人，请拆分文件。');
    const fields = {};
    for (const [key, { label, number }] of columns) {
      try {
        fields[key] = cellValue(row.getCell(number), key);
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        errors.push('第 ' + rowNumber + ' 行「' + label + '」' + error.message);
      }
    }
    rows.push({ rowNumber, fields });
  });
  if (errors.length) throw memberImportErrors(errors);
  if (!rows.length) throw new RequestError(422, '表内没有人员记录，请从第 2 行开始填写。');
  return rows;
}

export function memberImportErrors(errors) {
  const shown = 12;
  const lines = ['导入未执行。请检查以下内容。', ...errors.slice(0, shown)];
  if (errors.length > shown) lines.push('另有 ' + (errors.length - shown) + ' 处问题。');
  return new RequestError(422, lines.join('\n'));
}

export async function readMemberWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await validateWorkbookArchive(buffer);
    await workbook.xlsx.load(buffer, {
      ignoreNodes: ['mergeCells', 'hyperlinks', 'conditionalFormatting', 'dataValidations', 'drawing', 'picture', 'tableParts']
    });
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, '无法读取文件，请确认它是有效的 .xlsx 工作簿。');
  }
  const sheet = workbook.getWorksheet('人员导入') || workbook.worksheets[0];
  if (!sheet) throw new RequestError(422, '工作簿里没有可读取的工作表。');
  return readRows(sheet);
}
