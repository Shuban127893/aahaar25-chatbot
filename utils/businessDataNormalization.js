/*
Trims whitespace from every text field in
the delivery and menu data.

Without this, an invisible trailing space
typed into a stop name (e.g. "Hillsborough ")
displays identically everywhere, but fails
exact-match checks elsewhere (assignment
validation, driver stop lookups) against the
trimmed version of the same text - the two
look the same to a human but are different
strings to the computer.

Used both when data is saved (adminRoutes.js)
and when it's loaded at startup (server.js),
so data already saved with stray whitespace
before this existed gets cleaned up too,
without needing anyone to manually re-save it.
*/

/*
Canonical weekday order for sorting - matches
the order already used client-side in
admin.html (CANONICAL_DAY_ORDER), so a stop
list sorted here and one sorted in the browser
never disagree.
*/
const CANONICAL_DAY_ORDER = [
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "Monday",
];

function dayRank(day) {
  const index = CANONICAL_DAY_ORDER.indexOf(
    String(day || "").trim()
  );

  return index === -1
    ? CANONICAL_DAY_ORDER.length
    : index;
}

/*
Converts a time string like "11:30 AM" or a
range like "12:00 PM - 12:15 PM" into minutes
since midnight, using whichever time appears
first. Unparseable times sort to the end
rather than throwing, so a stop with an
unusual or malformed time still saves - it
just won't be positioned precisely.
*/
function parseTimeToMinutes(value) {
  const match =
    /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i.exec(
      String(value || "")
    );

  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }

  let hour = parseInt(match[1], 10);
  const minutes = match[2]
    ? parseInt(match[2], 10)
    : 0;

  const meridiem = match[3].toUpperCase();

  if (meridiem === "PM" && hour !== 12) {
    hour += 12;
  }

  if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }

  return hour * 60 + minutes;
}

/*
Sorts delivery stops by day, then by their
actual delivery time. This is what makes a
newly-added stop automatically land in its
correct chronological position instead of
wherever it happened to be typed into the
admin form - the sort runs on every save, so
position is always derived from the real
schedule, never from insertion order.

A stable sort (Array.prototype.sort in
modern Node is stable) means two stops with
identical times keep whatever relative order
they already had, rather than jumping around
unpredictably between saves.
*/
function sortDeliveryStops(stops) {
  return [...stops].sort((a, b) => {
    const dayDifference =
      dayRank(a.day) - dayRank(b.day);

    if (dayDifference !== 0) {
      return dayDifference;
    }

    return (
      parseTimeToMinutes(a.time) -
      parseTimeToMinutes(b.time)
    );
  });
}

function normalizeDeliveryInfo(data) {
  const normalized = { ...data };

  if (Array.isArray(normalized.deliveryStops)) {
    const trimmedStops =
      normalized.deliveryStops.map(
        (stop) => ({
          ...stop,
          day: String(stop.day || "").trim(),

          location: String(
            stop.location || ""
          ).trim(),

          time: String(
            stop.time || ""
          ).trim(),

          address: String(
            stop.address || ""
          ).trim(),
        })
      );

    normalized.deliveryStops =
      sortDeliveryStops(trimmedStops);
  }

  if (Array.isArray(normalized.lunchBoxIncludes)) {
    normalized.lunchBoxIncludes =
      normalized.lunchBoxIncludes.map(
        (item) => String(item || "").trim()
      );
  }

  return normalized;
}

function normalizeMenuInfo(data) {
  const normalized = { ...data };

  if (
    normalized.categories &&
    typeof normalized.categories === "object"
  ) {
    const categories = {};

    for (const categoryName of Object.keys(
      normalized.categories
    )) {
      categories[categoryName] =
        normalized.categories[
          categoryName
        ].map((item) => ({
          ...item,
          name: String(
            item.name || ""
          ).trim(),

          price: String(
            item.price || ""
          ).trim(),
        }));
    }

    normalized.categories = categories;
  }

  return normalized;
}

module.exports = {
  normalizeDeliveryInfo,
  normalizeMenuInfo,
};