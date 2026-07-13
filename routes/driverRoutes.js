const express = require("express");
const rateLimit = require("express-rate-limit");

const {
  authenticateDriver,
  createDriverSession,
  deleteDriverSession,
} = require("../services/driverAuthService");

function createDriverRouter({
  pool,
  requireDriver,
  getCookie,
  setCookie,
  clearCookie,
  sendWhatsAppMessage,
}) {
  const router = express.Router();

  const driverLoginLimiter =
    rateLimit({
      windowMs:
        15 * 60 * 1000,

      max: 10,

      standardHeaders: true,
      legacyHeaders: false,

      message: {
        success: false,

        error:
          "Too many login attempts. Try again later.",
      },
    });

  const stopTimes = {
    "Gateway Village":
      "11:30 AM",

    "Discovery Place":
      "11:45 AM",

    "Ally Center":
      "12:00 PM",

    "One Wells Fargo":
      "12:30 PM",
  };

  function normalizeStop(
    value = ""
  ) {
    const lower = String(value)
      .trim()
      .toLowerCase();

    if (
      lower.includes("gateway")
    ) {
      return "Gateway Village";
    }

    if (
      lower.includes("discovery")
    ) {
      return "Discovery Place";
    }

    if (
      lower.includes("ally")
    ) {
      return "Ally Center";
    }

    if (
      lower.includes("wells") ||
      lower.includes("fargo")
    ) {
      return "One Wells Fargo";
    }

    return null;
  }

  function normalizeDay(
    value = ""
  ) {
    const lower = String(value)
      .trim()
      .toLowerCase();

    if (
      lower.includes("tuesday")
    ) {
      return "Tuesday";
    }

    if (
      lower.includes("wednesday")
    ) {
      return "Wednesday";
    }

    if (
      lower.includes("thursday")
    ) {
      return "Thursday";
    }

    if (
      lower.includes("friday")
    ) {
      return "Friday";
    }

    return null;
  }

  function currentDeliveryDay() {
    const day =
      new Intl.DateTimeFormat(
        "en-US",
        {
          weekday: "long",
          timeZone:
            "America/New_York",
        }
      ).format(new Date());

    if (
      [
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
      ].includes(day)
    ) {
      return day;
    }

    return "Tuesday";
  }

  /*
  Driver login
  */

  router.post(
    "/driver/login",
    driverLoginLimiter,
    async (req, res) => {
      try {
        const driver =
          await authenticateDriver(
            pool,
            req.body.name,
            req.body.password
          );

        if (!driver) {
          return res.status(401).json({
            success: false,
            error:
              "Invalid login",
          });
        }

        const token =
          await createDriverSession(
            pool,
            driver.id,
            8
          );

        setCookie(
          res,
          "driver_session",
          token,
          8 * 60 * 60
        );

        return res.json({
          success: true,

          driver: {
            id: driver.id,
            name: driver.name,
            phone: driver.phone,
          },
        });
      } catch (error) {
        console.error(
          "Driver login error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            "Driver login failed",
        });
      }
    }
  );

  /*
  Driver logout
  */

  router.post(
    "/driver/logout",
    async (req, res) => {
      try {
        const token = getCookie(
          req,
          "driver_session"
        );

        await deleteDriverSession(
          pool,
          token
        );

        clearCookie(
          res,
          "driver_session"
        );

        return res.json({
          success: true,
        });
      } catch (error) {
        console.error(
          "Driver logout error:",
          error.message
        );

        clearCookie(
          res,
          "driver_session"
        );

        return res.json({
          success: true,
        });
      }
    }
  );

  /*
  Driver account and assignments
  */

  router.get(
    "/driver/me",
    requireDriver,
    async (req, res) => {
      try {
        if (!req.driver) {
          return res.status(401).json({
            success: false,
            error:
              "Driver account required",
          });
        }

        const requestedDay =
          normalizeDay(
            req.query.day
          );

        const day =
          requestedDay ||
          currentDeliveryDay();

        const assignments =
          await pool.query(
            `
            SELECT
              driver_assignments.day,
              driver_assignments.stop,

              COALESCE(
                route_progress.status,
                'not_started'
              ) AS route_status,

              COUNT(orders.id)
                FILTER (
                  WHERE
                    orders.status =
                    'confirmed'
                )::int
                AS confirmed_count

            FROM driver_assignments

            LEFT JOIN route_progress
              ON route_progress.day =
                 driver_assignments.day
             AND route_progress.stop =
                 driver_assignments.stop

            LEFT JOIN orders
              ON orders.day =
                 driver_assignments.day
             AND orders.stop =
                 driver_assignments.stop

            WHERE
              driver_assignments.driver_id =
                $1
              AND driver_assignments.day =
                $2

            GROUP BY
              driver_assignments.day,
              driver_assignments.stop,
              route_progress.status

            ORDER BY

              CASE
                driver_assignments.stop
                WHEN 'Gateway Village'
                  THEN 1
                WHEN 'Discovery Place'
                  THEN 2
                WHEN 'Ally Center'
                  THEN 3
                WHEN 'One Wells Fargo'
                  THEN 4
                ELSE 5
              END
            `,
            [
              req.driver.id,
              day,
            ]
          );

        return res.json({
          success: true,

          driver: {
            id:
              req.driver.id,

            name:
              req.driver.name,

            phone:
              req.driver.phone,
          },

          day,

          assignments:
            assignments.rows.map(
              (assignment) => ({
                ...assignment,

                time:
                  stopTimes[
                    assignment.stop
                  ] || "",
              })
            ),
        });
      } catch (error) {
        console.error(
          "Driver profile error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            "Could not load driver route",
        });
      }
    }
  );

  /*
  Send stop notification
  */

  router.post(
    "/driver/notify-stop",
    requireDriver,
    async (req, res) => {
      try {
        const stop =
          normalizeStop(
            req.body.stop
          );

        const day =
          normalizeDay(
            req.body.day
          ) ||
          currentDeliveryDay();

        const status = String(
          req.body.status || ""
        ).trim();

        const validStatuses = [
          "10min",
          "5min",
          "arrived",
          "delivered",
        ];

        if (!stop) {
          return res.status(400).json({
            success: false,
            error:
              "Invalid stop",
          });
        }

        if (
          !validStatuses.includes(
            status
          )
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Invalid status",
          });
        }

        /*
        When using the driver's
        browser session, verify the
        stop belongs to that driver.
        */

        if (req.driver) {
          const assignment =
            await pool.query(
              `
              SELECT id
              FROM driver_assignments

              WHERE day = $1
                AND stop = $2
                AND driver_id = $3

              LIMIT 1
              `,
              [
                day,
                stop,
                req.driver.id,
              ]
            );

          if (
            assignment.rows.length ===
            0
          ) {
            return res.status(403).json({
              success: false,

              error:
                "This stop is not assigned to your account",
            });
          }
        }

        const orderResult =
          await pool.query(
            `
            SELECT *
            FROM orders

            WHERE
              status = 'confirmed'
              AND day = $1
              AND stop = $2
            `,
            [
              day,
              stop,
            ]
          );

        const customers =
          orderResult.rows;

        const messages = {
          "10min":
            `AAHAAR25 Update: Your lunch box driver is about 10 minutes away from ${stop}.`,

          "5min":
            `AAHAAR25 Update: Your lunch box driver is about 5 minutes away from ${stop}. Please be ready at the delivery spot.`,

          arrived:
            `AAHAAR25 Update: Your lunch box driver has arrived at ${stop}. Please meet the driver at the delivery spot.`,

          delivered:
            "AAHAAR25 Update: Your lunch box has been delivered. Thank you for ordering from AAHAAR25!",
        };

        let sentCount = 0;

        for (
          const customer of customers
        ) {
          if (!customer.phone) {
            continue;
          }

          const result =
            await sendWhatsAppMessage(
              customer.phone,
              messages[status]
            );

          if (result.ok) {
            sentCount += 1;
          }
        }

        if (
          status === "delivered"
        ) {
          await pool.query(
            `
            UPDATE orders

            SET
              status = 'delivered',
              delivered_at = NOW()

            WHERE
              status = 'confirmed'
              AND day = $1
              AND stop = $2
            `,
            [
              day,
              stop,
            ]
          );
        }

        await pool.query(
          `
          INSERT INTO route_progress (
            day,
            stop,
            driver_id,
            status
          )
          VALUES (
            $1,
            $2,
            $3,
            $4
          )

          ON CONFLICT (
            day,
            stop
          )

          DO UPDATE SET
            driver_id =
              EXCLUDED.driver_id,

            status =
              EXCLUDED.status,

            updated_at = NOW()
          `,
          [
            day,
            stop,
            req.driver?.id || null,
            status,
          ]
        );

        if (req.driver) {
          await pool.query(
            `
            INSERT INTO driver_activity (
              driver_id,
              driver_name,
              action,
              stop,
              status,
              sent_count
            )
            VALUES (
              $1,
              $2,
              'notify_stop',
              $3,
              $4,
              $5
            )
            `,
            [
              req.driver.id,
              req.driver.name,
              stop,
              status,
              sentCount,
            ]
          );
        }

        return res.json({
          success: true,
          day,
          stop,
          status,
          sentCount,

          totalCustomers:
            customers.length,
        });
      } catch (error) {
        console.error(
          "Driver notification error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            "Driver notification failed",
        });
      }
    }
  );

  return router;
}

module.exports =
  createDriverRouter;