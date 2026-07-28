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

function normalizeDeliveryInfo(data) {
  const normalized = { ...data };

  if (Array.isArray(normalized.deliveryStops)) {
    normalized.deliveryStops =
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