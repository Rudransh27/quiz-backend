// src/utils/localDate.js
// Streak/engagement-history date bucketing must use the REQUESTING USER's
// local calendar day, not the server's UTC day — `new Date().toISOString()`
// is always UTC, so a user whose local day differs from UTC (anyone not at
// UTC+0) could have "today" resolve to the wrong calendar date for up to
// ~12 hours, making an already-qualified day look like it still applies (or
// the reverse, a real streak looking broken). The client computes its own
// local "YYYY-MM-DD" and sends it as `localDate`; these helpers trust that
// value when present and fall back to the server's UTC date otherwise, so
// any caller that hasn't been updated to send one keeps working exactly as
// before.

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 🔒 The client's date is only trusted within ±1 day of the server's UTC
// date (every real timezone, UTC−12…UTC+14, falls inside that). Anything
// else — e.g. replaying "2001-01-01", "2001-01-02", … to farm the
// once-per-day login bonus or forge a streak — falls back to the server date.
function resolveClientToday(localDateInput, now = new Date()) {
  const serverToday = now.toISOString().split('T')[0];
  if (typeof localDateInput === 'string' && LOCAL_DATE_RE.test(localDateInput)) {
    const allowed = [shiftDateKey(serverToday, -1), serverToday, shiftDateKey(serverToday, 1)];
    if (allowed.includes(localDateInput)) return localDateInput;
  }
  return serverToday;
}

// Pure calendar-day arithmetic on a "YYYY-MM-DD" key — anchored at UTC
// midnight purely so date-only math (add/subtract a day) can't be nudged
// across a day boundary by the server's own local clock; the string in and
// out is a plain calendar date, no time-of-day/timezone meaning attached.
function shiftDateKey(dateKey, deltaDays) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().split('T')[0];
}

module.exports = { resolveClientToday, shiftDateKey };
