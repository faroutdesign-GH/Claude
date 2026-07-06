'use strict';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Return the { year, month } (month 1-12) that an ISO datetime/date falls in,
 * evaluated in the given IANA timezone. Returns null for empty input.
 *
 * JobTread returns datetimes as UTC ISO strings and dates as 'YYYY-MM-DD'.
 * Plain dates have no time/zone, so they are read as-is.
 */
function toYearMonth(isoString, timeZone) {
  if (!isoString) return null;

  // Plain calendar date (no time component): read the Y-M directly.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoString);
  if (dateOnly) {
    return { year: Number(dateOnly[1]), month: Number(dateOnly[2]) };
  }

  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
  });
  const parts = fmt.formatToParts(d);
  const year = Number(parts.find((p) => p.type === 'year').value);
  const month = Number(parts.find((p) => p.type === 'month').value);
  return { year, month };
}

/** Zero-based month index 0-11 -> "January" ... */
function monthName(monthIndexZeroBased) {
  return MONTH_NAMES[monthIndexZeroBased];
}

/** "2026-03" key for a { year, month } (month 1-12). */
function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

module.exports = { toYearMonth, monthName, monthKey, MONTH_NAMES };
