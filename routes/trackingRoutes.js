const express = require("express");
const crypto = require("crypto");

const {
  getDrivingRoute,
} = require("../services/routingService");

/*
Tracking links are signed rather than
requiring a customer login - there's no
customer account system in this app. The
signature ties a link to one specific real
calendar day, so old links naturally stop
working the next day without needing any
cleanup or expiry table.

Reuses OTP_SECRET (already required and
already a server-side-only secret) rather
than requiring yet another environment
variable for something with the same trust
requirements.
*/

function buildTrackingToken(
  day,
  dateString,
  secret
) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${day}:${dateString}`)
    .digest("hex");
}

function verifyTrackingToken(
  day,
  dateString,
  token,
  secret
) {
  if (!token) {
    return false;
  }

  const expected = buildTrackingToken(
    day,
    dateString,
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

function createTrackingRouter({
  pool,
  getDeliveryInfo,
  otpSecret,
}) {
  const router = express.Router();

  /*
  Live tracking data for one day.

  Returns:
  - every driver assigned to ANY stop that
    day, with their current position (for
    map markers)
  - every stop for that day, with its
    coordinates, delivered/not-yet status,
    and - when that stop's assigned driver
    has a live location - a real road-based
    ETA and distance to that specific stop

  Polled repeatedly by the public tracking
  page.
  */

  router.get(
    "/track-data",
    async (req, res) => {
      try {
        const day = String(
          req.query.day || ""
        ).trim();

        const dateString = String(
          req.query.date || ""
        ).trim();

        const token = req.query.token;

        if (
          !verifyTrackingToken(
            day,
            dateString,
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
        lookup is logged and skipped rather
        than breaking the whole response.
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