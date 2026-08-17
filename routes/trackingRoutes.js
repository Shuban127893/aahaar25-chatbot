const express = require("express");
const crypto = require("crypto");

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
  Live tracking data for one day - the
  current position of every driver assigned
  to ANY stop that day, plus the day's stop
  list and each stop's delivered/not-yet
  status. Polled repeatedly by the public
  tracking page.
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

        const driverResult =
          await pool.query(
            `
            SELECT DISTINCT
              drivers.id,
              drivers.name,
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

        return res.json({
          success: true,

          drivers: driverResult.rows.map(
            (row) => ({
              id: row.id,
              name: row.name,

              hasLocation:
                row.latitude !== null,

              latitude: row.latitude,
              longitude: row.longitude,
              updatedAt: row.updated_at,
            })
          ),

          stops: stops.map((s) => ({
            location: s.location,
            time: s.time,

            status:
              progressResult.rows.find(
                (p) => p.stop === s.location
              )?.status || "not_started",
          })),
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