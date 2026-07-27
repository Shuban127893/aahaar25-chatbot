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
Given a weekday name, returns the next real
date (YYYY-MM-DD) that refers to - today,
if today already is that weekday, otherwise
the coming occurrence within the next week.
*/
function getNextDateForDay(dayName) {
  const today = getTodayInfo();

  const todayIndex =
    WEEKDAY_ORDER.indexOf(today.dayName);

  const targetIndex =
    WEEKDAY_ORDER.indexOf(dayName);

  if (todayIndex === -1 || targetIndex === -1) {
    return null;
  }

  let daysAhead = targetIndex - todayIndex;

  if (daysAhead < 0) {
    daysAhead += 7;
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
  formatDateForDisplay,
};