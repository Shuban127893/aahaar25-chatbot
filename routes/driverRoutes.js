const express = require("express");
const rateLimit = require("express-rate-limit");

const {
  getNextDateForDay,
} = require("../utils/dateHelpers");

const {
  normalizePhone,
  generateSixDigitCode,
  hashOneTimeCode,
  verifyOneTimeCodeHash,
  findActiveDriverByPhone,
  createDriverSession,
  deleteDriverSession,
  deleteAllDriverSessions,
  deleteAllDriverLoginCodes,
} = require("../services/driverAuthService");

function createDriverRouter({
  pool,
  requireDriver,
  getCookie,
  setCookie,
  clearCookie,
  sendWhatsAppMessage,
  getDeliveryInfo,
}) {
  const router = express.Router();

  const OTP_SECRET =
    process.env.OTP_SECRET;

  const driverCodeRequestLimiter =
    rateLimit({
      windowMs:
        15 * 60 * 1000,

      max: 5,

      standardHeaders: true,
      legacyHeaders: false,

      message: {
        success: false,

        error:
          "Too many login code requests. Please wait 15 minutes and try again.",
      },
    });

  const driverCodeVerificationLimiter =
    rateLimit({
      windowMs:
        15 * 60 * 1000,

      max: 15,

      standardHeaders: true,
      legacyHeaders: false,

      message: {
        success: false,

        error:
          "Too many verification attempts. Please wait 15 minutes and try again.",
      },
    });

  function getStopTimes() {
    const stops =
      getDeliveryInfo()?.deliveryStops || [];

    const map = {};

    for (const stop of stops) {
      if (stop.location) {
        map[stop.location] = stop.time || "";
      }
    }

    return map;
  }

  function normalizeStop(
    value = ""
  ) {
    const lower = String(value)
      .trim()
      .toLowerCase();

    const stops =
      getDeliveryInfo()?.deliveryStops || [];

    const locations = [
      ...new Set(
        stops
          .map((s) =>
            String(s.location || "").trim()
          )
          .filter(Boolean)
      ),
    ];

    const exact = locations.find(
      (location) =>
        lower.includes(
          location.toLowerCase()
        )
    );

    if (exact) {
      return exact;
    }

    const loose = locations.find(
      (location) => {
        const words = location
          .toLowerCase()
          .split(/\s+/)
          .filter(
            (word) => word.length > 3
          );

        return words.some((word) =>
          lower.includes(word)
        );
      }
    );

    return loose || null;
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

  function validPhoneNumber(
    phone
  ) {
    const normalized =
      normalizePhone(phone);

    return (
      normalized.length >= 10 &&
      normalized.length <= 15
    );
  }

  /*
  Request a temporary WhatsApp
  login code.

  The driver enters the same phone
  number saved by the administrator.
  */

  router.post(
    "/driver/request-code",
    driverCodeRequestLimiter,
    async (req, res) => {
      try {
        if (!OTP_SECRET) {
          console.error(
            "Driver OTP error: OTP_SECRET is missing"
          );

          return res.status(500).json({
            success: false,

            error:
              "Driver login is not configured yet.",
          });
        }

        const phone = String(
          req.body.phone || ""
        ).trim();

        if (!validPhoneNumber(phone)) {
          return res.status(400).json({
            success: false,

            error:
              "Enter a valid phone number.",
          });
        }

        const driver =
          await findActiveDriverByPhone(
            pool,
            phone
          );

        if (!driver) {
          return res.status(404).json({
            success: false,

            error:
              "No active driver account was found for that phone number.",
          });
        }

        /*
        Remove older unused codes so only
        the newest code can be entered.
        */

        await deleteAllDriverLoginCodes(
          pool,
          driver.id
        );

        const code =
          generateSixDigitCode();

        const codeHash =
          hashOneTimeCode(
            code,
            OTP_SECRET
          );

        await pool.query(
          `
          INSERT INTO driver_login_codes (
            driver_id,
            code_hash,
            expires_at,
            attempts
          )
          VALUES (
            $1,
            $2,
            NOW() + INTERVAL '10 minutes',
            0
          )
          `,
          [
            driver.id,
            codeHash,
          ]
        );

        const message =
          `Your AAHAAR25 driver login code is: ${code}\n\n` +
          `This code expires in 10 minutes. Do not share it with anyone.`;

        const sendResult =
          await sendWhatsAppMessage(
            driver.phone,
            message
          );

        if (!sendResult?.ok) {
          await deleteAllDriverLoginCodes(
            pool,
            driver.id
          );

          console.error(
            "Driver OTP WhatsApp error:",
            sendResult?.error ||
            "Unknown WhatsApp error"
          );

          return res.status(500).json({
            success: false,

            error:
              "The login code could not be sent through WhatsApp.",
          });
        }

        return res.json({
          success: true,

          message:
            "A temporary login code was sent through WhatsApp.",

          expiresInMinutes: 10,
        });
      } catch (error) {
        console.error(
          "Request driver code error:",
          error.message
        );

        return res.status(500).json({
          success: false,

          error:
            "Could not send the driver login code.",
        });
      }
    }
  );

  /*
  Verify the temporary code and create
  an authenticated driver session.
  */

  router.post(
    "/driver/verify-code",
    driverCodeVerificationLimiter,
    async (req, res) => {
      const client =
        await pool.connect();

      try {
        if (!OTP_SECRET) {
          console.error(
            "Driver OTP error: OTP_SECRET is missing"
          );

          return res.status(500).json({
            success: false,

            error:
              "Driver login is not configured yet.",
          });
        }

        const phone = String(
          req.body.phone || ""
        ).trim();

        const code = String(
          req.body.code || ""
        )
          .replace(/\D/g, "")
          .slice(0, 6);

        if (!validPhoneNumber(phone)) {
          return res.status(400).json({
            success: false,

            error:
              "Enter a valid phone number.",
          });
        }

        if (
          code.length !== 6
        ) {
          return res.status(400).json({
            success: false,

            error:
              "Enter the six-digit login code.",
          });
        }

        const driver =
          await findActiveDriverByPhone(
            client,
            phone
          );

        if (!driver) {
          return res.status(401).json({
            success: false,

            error:
              "The phone number or login code is incorrect.",
          });
        }

        await client.query("BEGIN");

        const codeResult =
          await client.query(
            `
            SELECT
              id,
              driver_id,
              code_hash,
              expires_at,
              used_at,
              attempts

            FROM driver_login_codes

            WHERE
              driver_id = $1
              AND used_at IS NULL

            ORDER BY
              created_at DESC

            LIMIT 1

            FOR UPDATE
            `,
            [driver.id]
          );

        const loginCode =
          codeResult.rows[0];

        if (!loginCode) {
          await client.query(
            "ROLLBACK"
          );

          return res.status(401).json({
            success: false,

            error:
              "No active login code was found. Request a new code.",
          });
        }

        if (
          new Date(
            loginCode.expires_at
          ).getTime() <= Date.now()
        ) {
          await client.query(
            `
            DELETE FROM driver_login_codes
            WHERE id = $1
            `,
            [loginCode.id]
          );

          await client.query(
            "COMMIT"
          );

          return res.status(401).json({
            success: false,

            error:
              "That login code has expired. Request a new code.",
          });
        }

        if (
          Number(
            loginCode.attempts || 0
          ) >= 5
        ) {
          await client.query(
            `
            DELETE FROM driver_login_codes
            WHERE id = $1
            `,
            [loginCode.id]
          );

          await client.query(
            "COMMIT"
          );

          return res.status(401).json({
            success: false,

            error:
              "Too many incorrect attempts. Request a new code.",
          });
        }

        const codeIsValid =
          verifyOneTimeCodeHash(
            code,
            loginCode.code_hash,
            OTP_SECRET
          );

        if (!codeIsValid) {
          await client.query(
            `
            UPDATE driver_login_codes

            SET attempts =
              attempts + 1

            WHERE id = $1
            `,
            [loginCode.id]
          );

          await client.query(
            "COMMIT"
          );

          const attemptsRemaining =
            Math.max(
              0,
              4 -
              Number(
                loginCode.attempts || 0
              )
            );

          return res.status(401).json({
            success: false,

            error:
              attemptsRemaining > 0
                ? `Incorrect code. ${attemptsRemaining} attempt${
                    attemptsRemaining === 1
                      ? ""
                      : "s"
                  } remaining.`
                : "Incorrect code. Request a new code.",
          });
        }

        /*
        Mark the code as used before
        creating the session.
        */

        await client.query(
          `
          UPDATE driver_login_codes

          SET used_at = NOW()

          WHERE id = $1
          `,
          [loginCode.id]
        );

        /*
        Remove older driver sessions.

        This prevents one driver's account
        from remaining signed in on several
        devices at the same time.
        */

        await deleteAllDriverSessions(
          client,
          driver.id
        );

        const token =
          await createDriverSession(
            client,
            driver.id,
            8
          );

        await client.query(
          "COMMIT"
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
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch {
          // Ignore rollback errors.
        }

        console.error(
          "Verify driver code error:",
          error.message
        );

        return res.status(500).json({
          success: false,

          error:
            "The login code could not be verified.",
        });
      } finally {
        client.release();
      }
    }
  );

  /*
  Driver logout.
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
  Load the authenticated driver's
  assignments for a requested day.
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
              "Driver login required.",
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
            (() => {
              const stopTimes =
                getStopTimes();

              return assignments.rows.map(
                (assignment) => ({
                  ...assignment,

                  time:
                    stopTimes[
                      assignment.stop
                    ] || "",
                })
              );
            })(),
        });
      } catch (error) {
        console.error(
          "Driver profile error:",
          error.message
        );

        return res.status(500).json({
          success: false,

          error:
            "Could not load the driver route.",
        });
      }
    }
  );

  /*
  Send delivery notifications to
  confirmed customers at an assigned
  stop.
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

        if (!req.driver) {
          return res.status(401).json({
            success: false,

            error:
              "Driver login required.",
          });
        }

        if (!stop) {
          return res.status(400).json({
            success: false,

            error:
              "Invalid delivery stop.",
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
              "Invalid delivery status.",
          });
        }

        const assignment =
          await pool.query(
            `
            SELECT id, day, stop

            FROM driver_assignments

            WHERE
              LOWER(TRIM(day)) = LOWER(TRIM($1))
              AND LOWER(TRIM(stop)) = LOWER(TRIM($2))
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
          const allDriverRows =
            await pool.query(
              `
              SELECT day, stop
              FROM driver_assignments
              WHERE driver_id = $1
              `,
              [req.driver.id]
            );

          console.error(
            "Assignment not found. Comparing:",
            {
              incomingDay: JSON.stringify(day),
              incomingStop: JSON.stringify(stop),
              driverId: req.driver.id,
              thisDriversAssignments:
                allDriverRows.rows.map(
                  (row) => ({
                    day: JSON.stringify(row.day),
                    stop: JSON.stringify(row.stop),
                  })
                ),
            }
          );

          return res.status(403).json({
            success: false,

            error:
              "This stop is not assigned to your account.",
          });
        }

        /*
        "day" is just a recurring weekday
        name ("Wednesday"), shared by every
        occurrence of that weekday across
        every week. Filtering only by day
        would let a stale confirmed order
        from a past week bleed into today's
        notifications or delivery marking.
        targetDate scopes this to the real
        calendar date this occurrence of
        the weekday refers to.
        */

        const targetDate =
          getNextDateForDay(day);

        const orderResult =
          await pool.query(
            `
            SELECT *

            FROM orders

            WHERE
              status = 'confirmed'
              AND day = $1
              AND stop = $2
              AND delivery_date = $3
            `,
            [
              day,
              stop,
              targetDate,
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

          if (result?.ok) {
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
              AND delivery_date = $3
            `,
            [
              day,
              stop,
              targetDate,
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
            req.driver.id,
            status,
          ]
        );

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
            "Driver notification failed.",
        });
      }
    }
  );

  return router;
}

module.exports =
  createDriverRouter;