const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const {
  getDrivingRoute,
} = require("../services/routingService");

/*
Tracking links are signed rather than
requiring a customer login - there's no
customer account system in this app.

The token is bound to a specific order's ID,
not just a day/date. This matters for two
reasons:

1. Every customer gets a UNIQUE link. Before
   this, the token only encoded day+date, so
   every customer being delivered to on the
   same day had the literal identical link -
   any one of them forwarding or leaking it
   exposed everyone else's link too.

2. Access auto-revokes. Since /track-data
   looks up the real order by its ID on every
   request and checks it's still active, a
   cancelled or refunded order's tracking
   link simply stops working - no expiry
   table or cleanup job needed.

Reuses OTP_SECRET (already required and
already a server-side-only secret) rather
than requiring yet another environment
variable for something with the same trust
requirements.
*/

function buildTrackingToken(
  orderId,
  secret
) {
  return crypto
    .createHmac("sha256", secret)
    .update(String(orderId))
    .digest("hex");
}

function verifyTrackingToken(
  orderId,
  token,
  secret
) {
  if (!token || !orderId) {
    return false;
  }

  const expected = buildTrackingToken(
    orderId,
    secret
  );

  const expectedBuffer = Buffer.from(
    expected,
    "hex"
  );

  const receivedBuffer = Buffer.from(
    String(token),
    "hex"
  );

  if (
    expectedBuffer.length !==
    receivedBuffer.length
  ) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      expectedBuffer,
      receivedBuffer
    );
  } catch {
    return false;
  }
}

/*
Orders in these statuses can still be
tracked. A cancelled or refunded order has
nothing left to deliver, so its link is
treated as invalid rather than showing a
stale route.
*/
const TRACKABLE_STATUSES = [
  "confirmed",
  "delivered",
];

function createTrackingRouter({
  pool,
  getDeliveryInfo,
  otpSecret,
}) {
  const router = express.Router();

  /*
  Read-only, but still worth its own limit -
  a tracking link could otherwise be polled
  or brute-forced far more aggressively than
  a normal customer's browser ever would.
  The 15-second auto-refresh interval used
  by the tracking page needs roughly 4
  requests/minute per open tab; this leaves
  generous headroom for a few family members
  or tabs sharing the same network.
  */
  const trackDataLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,

    message: {
      success: false,

      error:
        "Too many requests. Please wait a few minutes and try again.",
    },
  });

  /*
  Live tracking data for one order.

  Access requires knowing both the order's
  ID and its signed token - the ID alone
  isn't enough, and neither is a token
  without the matching order. The day, stop,
  and delivery date are all derived from the
  real order record, never trusted from
  client-supplied query params.

  Returns:
  - every driver assigned to a stop on that
    order's delivery day, with their current
    position (for map markers)
  - every stop for that day, with its
    coordinates, delivered/not-yet status,
    and - when that stop's assigned driver
    has a live location - a real road-based
    ETA and distance
  - which of those stops is this customer's
    own delivery, so the tracking page can
    personalize its headline to THEIR stop
    specifically, not just "whichever stop
    hasn't been delivered yet today"
  */

  router.get(
    "/track-data",
    trackDataLimiter,
    async (req, res) => {
      try {
        const orderId = String(
          req.query.order || ""
        ).trim();

        const token = req.query.token;

        if (
          !verifyTrackingToken(
            orderId,
            token,
            otpSecret
          )
        ) {
          return res.status(403).json({
            success: false,

            error:
              "Invalid or expired tracking link.",
          });
        }

        const orderResult =
          await pool.query(
            `
            SELECT
              day,
              stop,
              status,
              delivery_date

            FROM orders

            WHERE order_id = $1

            LIMIT 1
            `,
            [orderId]
          );

        const order =
          orderResult.rows[0];

        /*
        Deliberately the same generic error
        for "no such order" and "order isn't
        trackable right now" - distinguishing
        them would let someone probe for
        which order IDs exist.
        */
        if (
          !order ||
          !TRACKABLE_STATUSES.includes(
            order.status
          )
        ) {
          return res.status(403).json({
            success: false,

            error:
              "Invalid or expired tracking link.",
          });
        }

        const day = String(
          order.day || ""
        ).trim();

        /*
        One row per (stop, assigned driver),
        including that driver's current
        location. This is what lets each stop
        know exactly which driver is bringing
        it, not just "some driver is out
        today" - a customer's stop cares about
        the driver assigned to THAT stop.
        */
        const assignmentResult =
          await pool.query(
            `
            SELECT
              driver_assignments.stop,
              drivers.id
                AS driver_id,
              drivers.name
                AS driver_name,
              driver_locations.latitude,
              driver_locations.longitude,
              driver_locations.updated_at

            FROM driver_assignments

            JOIN drivers
              ON drivers.id =
                 driver_assignments.driver_id

            LEFT JOIN driver_locations
              ON driver_locations.driver_id =
                 drivers.id

            WHERE
              driver_assignments.day = $1
              AND driver_assignments.driver_id
                  IS NOT NULL
            `,
            [day]
          );

        const progressResult =
          await pool.query(
            `
            SELECT
              stop,
              status

            FROM route_progress

            WHERE day = $1
            `,
            [day]
          );

        const stops =
          getDeliveryInfo()?.deliveryStops?.filter(
            (s) => s.day === day
          ) || [];

        /*
        Unique drivers for the day, for map
        markers - a driver can be assigned to
        more than one stop, so this collapses
        the assignment rows down to one entry
        per driver.
        */
        const driversById = new Map();

        for (const row of assignmentResult.rows) {
          if (!driversById.has(row.driver_id)) {
            driversById.set(row.driver_id, {
              id: row.driver_id,
              name: row.driver_name,

              hasLocation:
                row.latitude !== null,

              latitude: row.latitude,
              longitude: row.longitude,
              updatedAt: row.updated_at,
            });
          }
        }

        /*
        For each stop, find its assigned
        driver's row and - if both the stop
        and the driver have real coordinates -
        calculate a real road-based ETA and
        distance. Any single failed routing
        lookup is logged and reported via
        etaUnavailableReason rather than
        breaking the whole response.
        */
        const stopsWithEta = await Promise.all(
          stops.map(async (stop) => {
            const assignment =
              assignmentResult.rows.find(
                (row) => row.stop === stop.location
              );

            const status =
              progressResult.rows.find(
                (p) => p.stop === stop.location
              )?.status || "not_started";

            const base = {
              location: stop.location,
              time: stop.time,
              latitude: stop.latitude ?? null,
              longitude: stop.longitude ?? null,
              status,

              driverName:
                assignment?.driver_name || null,

              etaMinutes: null,
              distanceMiles: null,
              etaUnavailableReason: null,
            };

            if (status === "delivered") {
              return base;
            }

            const hasAssignment =
              Boolean(assignment);

            const hasStopCoords =
              stop.latitude != null &&
              stop.longitude != null;

            const hasDriverCoords =
              assignment?.latitude != null &&
              assignment?.longitude != null;

            if (!hasAssignment) {
              base.etaUnavailableReason =
                "no_driver_assigned";

              return base;
            }

            if (!hasStopCoords) {
              base.etaUnavailableReason =
                "stop_location_unknown";

              return base;
            }

            if (!hasDriverCoords) {
              base.etaUnavailableReason =
                "driver_location_unknown";

              return base;
            }

            try {
              const route =
                await getDrivingRoute(
                  assignment.latitude,
                  assignment.longitude,
                  stop.latitude,
                  stop.longitude
                );

              if (route) {
                base.etaMinutes = Math.max(
                  1,
                  Math.round(
                    route.durationSeconds / 60
                  )
                );

                base.distanceMiles =
                  Math.round(
                    (route.distanceMeters /
                      1609.34) *
                      10
                  ) / 10;
              } else {
                base.etaUnavailableReason =
                  "route_not_found";
              }
            } catch (error) {
              console.error(
                `ETA calculation failed for "${stop.location}":`,
                error.message
              );

              base.etaUnavailableReason =
                "route_lookup_failed";
            }

            return base;
          })
        );

        return res.json({
          success: true,

          day,

          yourStop: String(
            order.stop || ""
          ).trim(),

          drivers: Array.from(
            driversById.values()
          ),

          stops: stopsWithEta,
        });
      } catch (error) {
        console.error(
          "Track data error:",
          error.message
        );

        return res.status(500).json({
          success: false,

          error:
            "Could not load tracking data.",
        });
      }
    }
  );

  return router;
}

module.exports = {
  createTrackingRouter,
  buildTrackingToken,
};