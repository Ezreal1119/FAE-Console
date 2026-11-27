const priorityHours = { 低: 8, 中: 6, 高: 4, 很高: 2, 立即: 0 };
export const PRIORITY_BUFFER_HOURS = priorityHours;
export const TASK_PRIORITIES = Object.keys(priorityHours);
export const ACTIVE_TASK_STATUSES = ['开发中', '测试中'];
export const normalizeTaskPriority = priority => priority === '极高' ? '很高' : priority;

const minuteMs = 60_000;
const dayMinutes = 24 * 60;
const shanghaiOffset = 8 * 60;
const workPeriods = [[9 * 60, 12 * 60], [13 * 60 + 30, 18 * 60]];
const gregorianCycleDays = 146_097;
const workdayMinutes = workPeriods.reduce((total, [opens, closes]) => total + closes - opens, 0);
const cycleWorkMinutes = (gregorianCycleDays / 7 * 5 + 400 * 12) * workdayMinutes;

export function formatPlanningTime(timestamp) {
  const date = new Date(Date.parse(timestamp) + shanghaiOffset * minuteMs);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16).replace('T', ' ') : '';
}

export function plannedCompletion(startedAt, hours, priority) {
  priority = normalizeTaskPriority(priority);
  const workMinutes = Math.round(hours * 60);
  if (typeof hours !== 'number' || !Number.isSafeInteger(workMinutes) || workMinutes < 1 ||
      !Object.hasOwn(priorityHours, priority)) return null;

  const start = Math.floor(Date.parse(startedAt) / minuteMs) + shanghaiOffset;
  let remaining = workMinutes + priorityHours[priority] * 60;
  if (!Number.isSafeInteger(remaining) || !Number.isFinite(start)) return null;

  // The calendar repeats every 400 years. Skip complete cycles so even very large inputs are bounded.
  const cycles = Math.floor((remaining - 1) / cycleWorkMinutes);
  let cursor = start + cycles * gregorianCycleDays * dayMinutes;
  remaining -= cycles * cycleWorkMinutes;
  if (!Number.isFinite(new Date(cursor * minuteMs).getTime())) return null;

  let day = Math.floor(cursor / dayMinutes) * dayMinutes;
  for (; remaining > 0; day += dayMinutes) {
    const date = new Date(day * minuteMs);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) return null;
    const weekday = date.getUTCDay();
    const lastSaturday = weekday === 6 && date.getUTCMonth() !== new Date((day + 7 * dayMinutes) * minuteMs).getUTCMonth();
    if (weekday === 0 || (weekday === 6 && !lastSaturday)) continue;
    for (const [opens, closes] of workPeriods) {
      const from = Math.max(cursor, day + opens);
      const available = day + closes - from;
      if (available <= 0) continue;
      if (remaining <= available) return new Date((from + remaining - shanghaiOffset) * minuteMs).toISOString();
      remaining -= available;
    }
  }
  return null;
}
