import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

const stages = ['EVT', 'DVT', 'PVT', 'MP'];
const hoursPerDay = 8;

export async function readNpiStages(filename) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile(filename));
  const sheet = workbook.getWorksheet('内部');
  if (!sheet || sheet.getCell('D1').text.trim() !== '需求资料' ||
      sheet.getCell('F1').text.trim() !== 'NPI内部' ||
      sheet.getCell('G1').text.normalize('NFKC').replace(/\s/g, '') !== 'T1(天)') {
    throw new Error('「内部」工作表的需求资料、NPI内部或T1（天）列缺失。');
  }

  const requirements = Object.fromEntries(stages.map(stage => [stage, []]));
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const stage = row.getCell(3).text.trim();
    if (!Object.hasOwn(requirements, stage)) return;
    const description = row.getCell(4).text.trim();
    const deliverable = row.getCell(6).text.trim();
    const time = row.getCell(7).master;
    const blank = time.value == null || time.value === '';
    if (!description && !deliverable && blank) return;
    const days = time.type === ExcelJS.ValueType.Formula ? time.result : time.value;
    if (!blank && (typeof days !== 'number' || !Number.isFinite(days) || days < 0)) {
      throw new Error(`「内部」工作表第 ${rowNumber} 行的 T1（天）没有有效数值。`);
    }
    const rows = requirements[stage];
    rows.push({
      code: `${stage}-${String(rows.length + 1).padStart(3, '0')}`,
      description,
      deliverable,
      planned_hours: blank ? null : days * hoursPerDay
    });
  });
  return requirements;
}
