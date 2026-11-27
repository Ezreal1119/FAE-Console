const utf8 = new TextEncoder();
const csvHeader = [
  '任务', '项目', '状态', '负责人', '计划完成', '开始时间', '完成时间', '工时(h)', '完成结果', '附件',
  '工单分类', '设备类型', '项目阶段', '优先级', '合作者', '来源需求', '派发时间', '计划工时(h)', '前置依赖', '任务描述'
];
const maxAttachmentBytes = 180 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function csvCell(value) {
  let input = String(value ?? '');
  if (typeof value !== 'number' && /^[\t\r\n ]*[=+\-@]/.test(input)) input = "'" + input;
  return '"' + input.replaceAll('"', '""') + '"';
}
function safeFilename(name) {
  return String(name || '未命名').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/^[.]+|[. ]+$/g, '').slice(0, 100) || '未命名';
}
function csvBytes(tasks) {
  const records = tasks.map(task => [
    '#' + task.id + ' ' + task.title, task.proj, task.status, task.owner_name, task.dueDate,
    task.startDate, task.endDate, task.hours, task.result, task.fileName,
    task.category, task.device_type, task.project_stage, task.pri, task.collaboratorNames,
    task.sourceDemandCode, task.dispatchTime, task.planned_hours, task.deps, task.desc
  ]);
  return utf8.encode('\ufeff' + [csvHeader, ...records].map(record => record.map(csvCell).join(',')).join('\r\n'));
}

function zip(files) {
  const localParts = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  const now = new Date();
  const day = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  for (const [path, bytes] of files) {
    const name = utf8.encode(path);
    const size = bytes.length;
    const checksum = crc32(bytes);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true);
    header.setUint16(10, time, true);
    header.setUint16(12, day, true);
    header.setUint32(14, checksum, true);
    header.setUint32(18, size, true);
    header.setUint32(22, size, true);
    header.setUint16(26, name.length, true);
    localParts.push(header.buffer, name, bytes);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, checksum, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    directory.push(entry.buffer, name);
    directorySize += 46 + name.length;
    offset += 30 + name.length + size;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...localParts, ...directory, end.buffer], { type: 'application/zip' });
}

export async function exportWeek(tasks, exportName, fetchAttachment) {
  const files = [['本周工作任务.csv', csvBytes(tasks)]];
  const skipped = [];
  let totalBytes = 0;
  for (const task of tasks.filter(row => row.fileName)) {
    try {
      if (files.length >= 65534 || totalBytes >= maxAttachmentBytes) throw new Error('本次导出已达到浏览器附件容量限制。');
      const blob = await fetchAttachment(task);
      if (totalBytes + blob.size > maxAttachmentBytes) throw new Error('本次导出已达到浏览器附件容量限制。');
      const name = '附件/' + task.id + ' ' + safeFilename(task.title) + '/' + safeFilename(task.fileName);
      files.push([name, new Uint8Array(await blob.arrayBuffer())]);
      totalBytes += blob.size;
    } catch (error) {
      skipped.push('#' + task.id + ' ' + task.title + ' / ' + task.fileName + '：' + error.message);
    }
  }
  if (skipped.length) files.push(['未能导出的附件.txt', utf8.encode(skipped.join('\r\n'))]);
  const url = URL.createObjectURL(zip(files));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename(exportName) + '.zip';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return skipped.length;
}
