/*
Every "day" in this app (orders, delivery
stops, assignments) is stored as a weekday
NAME like "Tuesday" - never a real calendar
date. That's fine for recurring things like
driver assignments, but it means the system
has never actually known what day it is, or
which real date a customer's order is for.

This file is the one place that knows:
- what day/date it is right now, in the
  restaurant's own timezone (not the
  server's, which may be UTC)
- given a weekday name like "Tuesday", the
  next real calendar date that refers to
  (today, if today IS that weekday)
*/

const RESTAURANT_TIMEZONE = "America/New_York";

const WEEKDAY_ORDER = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/*
Returns today's weekday name and date
(YYYY-MM-DD), correctly localized to the
restaurant's timezone regardless of what
timezone the server itself runs in.
*/
function getTodayInfo() {
  const parts = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: RESTAURANT_TIMEZONE,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).formatToParts(new Date());

  const map = {};

  for (const part of parts) {
    map[part.type] = part.value;
  }

  return {
    dayName: map.weekday,
    dateString: `${map.year}-${map.month}-${map.day}`,
  };
}

/*
Parses a time string like "10:45 AM" into
minutes since midnight, for comparing against
the current time of day.
*/
function parseTimeToMinutes(timeText) {
  const match = String(timeText || "")
    .trim()
    .match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);

  if (!match) {
    return null;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3].toUpperCase();

  if (meridiem === "PM" && hours !== 12) {
    hours += 12;
  }

  if (meridiem === "AM" && hours === 12) {
    hours = 0;
  }

  return hours * 60 + minutes;
}

/*
Returns the current time of day, in minutes
since midnight, in the restaurant's timezone.
*/
function getCurrentTimeMinutes() {
  const parts = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: RESTAURANT_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }
  ).formatToParts(new Date());

  const map = {};

  for (const part of parts) {
    map[part.type] = part.value;
  }

  return (
    Number(map.hour) * 60 + Number(map.minute)
  );
}

/*
True if a weekday is still orderable THIS
week - i.e. it hasn't already happened this
week, and if it's today, the same-day cutoff
hasn't passed yet. Used to decide which days
to even show as options, rather than showing
a stale day and silently redirecting its date.
*/
function isOrderableThisWeek(
  dayName,
  cutoffTime
) {
  const today = getTodayInfo();

  const todayIndex =
    WEEKDAY_ORDER.indexOf(today.dayName);

  const targetIndex =
    WEEKDAY_ORDER.indexOf(dayName);

  if (todayIndex === -1 || targetIndex === -1) {
    return false;
  }

  const rawDaysAhead =
    targetIndex - todayIndex;

  if (rawDaysAhead < 0) {
    // Already happened this week.
    return false;
  }

  if (rawDaysAhead === 0 && cutoffTime) {
    const cutoffMinutes =
      parseTimeToMinutes(cutoffTime);

    if (
      cutoffMinutes !== null &&
      getCurrentTimeMinutes() >=
        cutoffMinutes
    ) {
      return false;
    }
  }

  return true;
}

/*
Given a weekday name, returns the real date
(YYYY-MM-DD) for its next occurrence - today,
if today already is that weekday, otherwise
the coming occurrence within the next week.

weeksAhead adds whole extra weeks on top of
that - weeksAhead=1 means "this same weekday,
but next week" regardless of today's cutoff,
since a week out is always far enough ahead
to be orderable.
*/
function getNextDateForDay(
  dayName,
  weeksAhead = 0
) {
  const today = getTodayInfo();

  const todayIndex =
    WEEKDAY_ORDER.indexOf(today.dayName);

  const targetIndex =
    WEEKDAY_ORDER.indexOf(dayName);

  if (todayIndex === -1 || targetIndex === -1) {
    return null;
  }

  let daysAhead;

  if (weeksAhead > 0) {
    /*
    Calendar-week-accurate: this calendar
    week's occurrence of the day (which may
    already be in the past, e.g. this week's
    Tuesday when today is Wednesday) plus a
    fixed number of full weeks.

    This must NOT reuse the "nearest future
    occurrence" wraparound below - a day that
    already passed this week already jumps
    forward via that wraparound, so stacking
    +7 more on top of it overshoots by a full
    week for exactly those days (e.g. asking
    for "next week's Tuesday" would silently
    return the Tuesday after that instead).
    */
    daysAhead =
      targetIndex - todayIndex + weeksAhead * 7;
  } else {
    // Nearest upcoming occurrence, including today.
    daysAhead = targetIndex - todayIndex;

    if (daysAhead < 0) {
      daysAhead += 7;
    }
  }

  const [year, month, day] = today.dateString
    .split("-")
    .map(Number);

  // Pure calendar-date arithmetic done in UTC
  // on purpose, to avoid daylight-saving-time
  // edge cases when just adding whole days.
  const target = new Date(
    Date.UTC(year, month - 1, day + daysAhead)
  );

  const yyyy = target.getUTCFullYear();

  const mm = String(
    target.getUTCMonth() + 1
  ).padStart(2, "0");

  const dd = String(
    target.getUTCDate()
  ).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

/*
Formats a date as something readable, e.g.
"Jul 28". Doesn't include the weekday name,
since every caller already has that
separately (e.g. "Tuesday") and would
otherwise duplicate it.

Accepts either a plain "YYYY-MM-DD" string
(from getNextDateForDay) or a real JS Date
object - Postgres's node driver returns DATE
columns as Date objects, not strings, so this
needs to handle both without crashing.
*/
function formatDateForDisplay(dateInput) {
  if (!dateInput) {
    return "";
  }

  let year;
  let month;
  let day;

  if (dateInput instanceof Date) {
    year = dateInput.getUTCFullYear();
    month = dateInput.getUTCMonth() + 1;
    day = dateInput.getUTCDate();
  } else {
    [year, month, day] = String(dateInput)
      .split("-")
      .map(Number);
  }

  const date = new Date(
    Date.UTC(year, month - 1, day)
  );

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(date);
}

module.exports = {
  RESTAURANT_TIMEZONE,
  WEEKDAY_ORDER,
  getTodayInfo,
  getNextDateForDay,
  isOrderableThisWeek,
  formatDateForDisplay,
  parseTimeToMinutes,
  getCurrentTimeMinutes,
};