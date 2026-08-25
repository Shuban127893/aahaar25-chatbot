/*
Converts a stop's text address into
latitude/longitude using OpenStreetMap's
free Nominatim geocoding service.

Only re-geocodes an address when it's new
or has changed since the last save - this
respects Nominatim's usage policy (max 1
request/second, no bulk geocoding), since a
normal admin save shouldn't hammer the API
for stops that didn't change.
*/

const GEOCODE_ENDPOINT =
  "https://nominatim.openstreetmap.org/search";

async function geocodeAddress(address) {
  const trimmed = String(address || "").trim();

  if (!trimmed) {
    return null;
  }

  const url =
    `${GEOCODE_ENDPOINT}?format=json&limit=1&q=` +
    encodeURIComponent(trimmed);

  const response = await fetch(url, {
    headers: {
      /*
      Nominatim requires a real identifying
      User-Agent - requests without one can
      be blocked.
      */
      "User-Agent":
        "AAHAAR25-DeliveryTracking/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Geocoding request failed: ${response.status}`
    );
  }

  const results = await response.json();

  if (
    !Array.isArray(results) ||
    results.length === 0
  ) {
    return null;
  }

  const best = results[0];

  const latitude = Number(best.lat);
  const longitude = Number(best.lon);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }

  return { latitude, longitude };
}

function delay(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

/*
Takes the newly-saved list of stops and the
previously-saved list, and returns a new list
where every stop has latitude/longitude -
geocoding only what's actually new or changed,
and carrying forward existing coordinates
otherwise.
*/
async function geocodeStopsIfNeeded(
  newStops,
  previousStops
) {
  const previousByKey = new Map();

  for (const stop of previousStops || []) {
    const key = `${stop.day}::${stop.location}`;
    previousByKey.set(key, stop);
  }

  const results = [];

  for (const stop of newStops) {
    const key = `${stop.day}::${stop.location}`;
    const previous = previousByKey.get(key);

    if (!stop.address) {
      results.push({
        ...stop,
        latitude: null,
        longitude: null,
      });

      continue;
    }

    const addressUnchanged =
      previous &&
      previous.address === stop.address &&
      previous.latitude != null &&
      previous.longitude != null;

    if (addressUnchanged) {
      results.push({
        ...stop,
        latitude: previous.latitude,
        longitude: previous.longitude,
      });

      continue;
    }

    try {
      const coords = await geocodeAddress(
        stop.address
      );

      results.push({
        ...stop,

        latitude: coords
          ? coords.latitude
          : null,

        longitude: coords
          ? coords.longitude
          : null,
      });

      if (!coords) {
        console.warn(
          `Could not geocode address for "${stop.location}": "${stop.address}"`
        );
      }
    } catch (error) {
      console.error(
        `Geocoding failed for "${stop.location}":`,
        error.message
      );

      /*
      Keep any previously-known coordinates
      rather than wiping them out just because
      this one geocode attempt failed (e.g. a
      transient network error).
      */
      results.push({
        ...stop,
        latitude: previous?.latitude ?? null,
        longitude: previous?.longitude ?? null,
      });
    }

    // Stay under 1 request/second.
    await delay(1100);
  }

  return results;
}

module.exports = {
  geocodeAddress,
  geocodeStopsIfNeeded,
};