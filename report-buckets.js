const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OFFSET = 9 * HOUR;
const INTERVALS = { minutely: MINUTE, hourly: HOUR, daily: DAY, weekly: 7 * DAY };

function bucketStart(timestamp, unit) {
  if (unit === "monthly" || unit === "yearly") {
    const date = new Date(timestamp + OFFSET);
    return Date.UTC(date.getUTCFullYear(), unit === "yearly" ? 0 : date.getUTCMonth(), 1) - OFFSET;
  }
  const interval = INTERVALS[unit];
  if (!interval) throw new Error("지원하지 않는 집계 단위입니다.");
  const mondayOffset = unit === "weekly" ? 3 * DAY : 0;
  return Math.floor((timestamp + OFFSET + mondayOffset) / interval) * interval - OFFSET - mondayOffset;
}

function nextBucketStart(timestamp, unit) {
  if (unit === "monthly" || unit === "yearly") {
    const date = new Date(timestamp + OFFSET);
    return unit === "yearly" ? Date.UTC(date.getUTCFullYear() + 1, 0, 1) - OFFSET : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - OFFSET;
  }
  const interval = INTERVALS[unit];
  if (!interval) throw new Error("지원하지 않는 집계 단위입니다.");
  return timestamp + interval;
}

module.exports = { bucketStart, nextBucketStart };