/*
Calculates real road-based driving distance
and duration between two coordinates, using
OSRM's public demo routing server (free, no
API key required).

Results are cached briefly in memory. The
tracking page polls every 15 seconds, and
multiple customers could have a tracking
link open for the same driver/stop pair at
once - without caching, the same route could
get requested dozens of times a minute for
coordinates that haven't meaningfully moved.
*/

const ROUTE_CACHE_TTL_MS = 10000;

const routeCache = new Map();

function roundCoord(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function cacheKey(fromLat, fromLng, toLat, toLng) {
  return [
    roundCoord(fromLat),
    roundCoord(fromLng),
    roundCoord(toLat),
    roundCoord(toLng),
  ].join(",");
}

/*
Returns { distanceMeters, durationSeconds }
for driving from (fromLat, fromLng) to
(toLat, toLng), or null if no route could
be found. Throws only on an actual request
failure (network error, non-OK response) -
callers should decide how to degrade
gracefully (e.g. hide the ETA rather than
break the whole tracking page).
*/
async function getDrivingRoute(
  fromLat,
  fromLng,
  toLat,
  toLng
) {
  const key = cacheKey(
    fromLat,
    fromLng,
    toLat,
    toLng
  );

  const cached = routeCache.get(key);

  if (
    cached &&
    Date.now() - cached.timestamp <
      ROUTE_CACHE_TTL_MS
  ) {
    return cached.data;
  }

  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${fromLng},${fromLat};${toLng},${toLat}` +
    `?overview=false`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Routing request failed: ${response.status}`
    );
  }

  const data = await response.json();

  const route = data?.routes?.[0];

  if (!route) {
    routeCache.set(key, {
      data: null,
      timestamp: Date.now(),
    });

    return null;
  }

  const result = {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
  };

  routeCache.set(key, {
    data: result,
    timestamp: Date.now(),
  });

  return result;
}

module.exports = {
  getDrivingRoute,
};