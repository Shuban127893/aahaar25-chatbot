const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const {
  hashPassword,
  deleteAllDriverSessions,
} = require("../services/driverAuthService");

const {
  getSquarePayment,
  refundSquarePayment,
} = require("../services/squareService");

function createAdminRouter({
  pool,
  requireAdmin,
  requireAdminPage,
  getCookie,
  setCookie,
  clearCookie,
  sendWhatsAppMessage,
}) {
  const router = express.Router();

  const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_API_KEY;

  const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error:
        "Too many login attempts. Try again later.",
    },
  });

  /*
  Admin page protection
  */

  router.get(
    "/admin",
    requireAdminPage,
    (req, res) => {
      return res.sendFile(
        "admin.html",
        {
          root: "public",
        }
      );
    }
  );

  /*
  Admin login
  */

  router.post(
    "/admin/login",
    adminLoginLimiter,
    async (req, res) => {
      try {
        const password = String(
          req.body.password || ""
        );

        if (
          !ADMIN_PASSWORD ||
          password !== ADMIN_PASSWORD
        ) {
          return res.status(401).json({
            success: false,
            error:
              "Invalid admin password",
          });
        }

        const token = crypto
          .randomBytes(32)
          .toString("hex");

        await pool.query(
          `
          INSERT INTO admin_sessions (
            token,
            expires_at
          )
          VALUES (
            $1,
            NOW() + INTERVAL '8 hours'
          )
          `,
          [token]
        );

        setCookie(
          res,
          "admin_session",
          token,
          8 * 60 * 60
        );

        return res.json({
          success: true,
        });
      } catch (error) {
        console.error(
          "Admin login error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            "Admin login failed",
        });
      }
    }
  );

  /*
  Admin logout
  */

  router.post(
    "/admin/logout",
    async (req, res) => {
      try {
        const token = getCookie(
          req,
          "admin_session"
        );

        if (token) {
          await pool.query(
            `
            DELETE FROM admin_sessions
            WHERE token = $1
            `,
            [token]
          );
        }

        clearCookie(
          res,
          "admin_session"
        );

        return res.json({
          success: true,
        });
      } catch (error) {
        console.error(
          "Admin logout error:",
          error.message
        );

        clearCookie(
          res,
          "admin_session"
        );

        return res.json({
          success: true,
        });
      }
    }
  );

  /*
  Overview statistics
  */

  router.get(
    "/admin/overview",
    requireAdmin,
    async (req, res) => {
      try {
        const result = await pool.query(
          `
          SELECT
            COUNT(*)::int AS total_orders,

            COUNT(*) FILTER (
              WHERE status = 'pending'
            )::int AS pending_orders,

            COUNT(*) FILTER (
              WHERE status = 'confirmed'
            )::int AS confirmed_orders,

            COUNT(*) FILTER (
              WHERE status = 'delivered'
            )::int AS delivered_orders,

            COUNT(*) FILTER (
              WHERE status = 'cancelled'
            )::int AS cancelled_orders,

            COUNT(*) FILTER (
              WHERE status = 'refunded'
            )::int AS refunded_orders,

            COALESCE(
              SUM(
                CASE
                  WHEN status IN (
                    'confirmed',
                    'delivered'
                  )
                  THEN 1399
                  ELSE 0
                END
              ),
              0
            )::int AS revenue_cents

          FROM orders

          WHERE created_at >=
            date_trunc(
              'day',
              NOW() AT TIME ZONE
              'America/New_York'
            )
          `
        );

        return res.json({
          success: true,
          stats: result.rows[0],
        });
      } catch (error) {
        console.error(
          "Admin overview error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            "Could not load overview",
        });
      }
    }
  );

  /*
  Load orders
  */

  router.get(
    "/admin/orders",
    requireAdmin,
    async (req, res) => {
      try {
        const result = await pool.query(
          `
          SELECT
            orders.*,
            drivers.name AS assigned_driver

          FROM orders

          LEFT JOIN driver_assignments
            ON driver_assignments.day =
               orders.day
           AND driver_assignments.stop =
               orders.stop

          LEFT JOIN drivers
            ON drivers.id =
               driver_assignments.driver_id

          ORDER BY
            orders.created_at DESC

          LIMIT 500
          `
        );

        return res.json(
          result.rows
        );
      } catch (error) {
        console.error(
          "Admin orders error:",
          error.message
        );

        return res.status(500).json([]);
      }
    }
  );

  /*
  Manually confirm order
  */

  router.post(
    "/admin/confirm-order",
    requireAdmin,
    async (req, res) => {
      try {
        const orderId = String(
          req.body.orderId || ""
        ).trim();

        if (!orderId) {
          return res.status(400).json({
            success: false,
            error:
              "Missing order ID",
          });
        }

        const result = await pool.query(
          `
          UPDATE orders
          SET
            status = 'confirmed',
            confirmed_at =
              COALESCE(
                confirmed_at,
                NOW()
              )

          WHERE order_id = $1

          RETURNING *
          `,
          [orderId]
        );

        const order =
          result.rows[0];

        if (!order) {
          return res.status(404).json({
            success: false,
            error:
              "Order not found",
          });
        }

        if (order.phone) {
          await sendWhatsAppMessage(
            order.phone,

            `✅ Your AAHAAR25 order has been confirmed.\n\n` +
              `Day: ${
                order.day || "Today"
              }\n` +
              `Stop: ${
                order.stop ||
                "Not selected"
              }\n\n` +
              `You will receive delivery updates on WhatsApp.`
          );
        }

        return res.json({
          success: true,
          order,
        });
      } catch (error) {
        console.error(
          "Confirm order error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            "Could not confirm order",
        });
      }
    }
  );

  /*
  Cancel or refund order
  */

  router.post(
    "/admin/cancel-order",
    requireAdmin,
    async (req, res) => {
      try {
        const orderId = String(
          req.body.orderId || ""
        ).trim();

        if (!orderId) {
          return res.status(400).json({
            success: false,
            error:
              "Missing order ID",
          });
        }

        const orderResult =
          await pool.query(
            `
            SELECT *
            FROM orders
            WHERE order_id = $1
            LIMIT 1
            `,
            [orderId]
          );

        const order =
          orderResult.rows[0];

        if (!order) {
          return res.status(404).json({
            success: false,
            error:
              "Order not found",
          });
        }

        if (
          [
            "cancelled",
            "refunded",
            "refund_pending",
          ].includes(order.status)
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Order is already closed",
          });
        }

        /*
        Unpaid order:
        cancel without Square refund.
        */

        if (
          !order.square_payment_id
        ) {
          const updated =
            await pool.query(
              `
              UPDATE orders
              SET status = 'cancelled'
              WHERE order_id = $1
              RETURNING *
              `,
              [orderId]
            );

          if (order.phone) {
            await sendWhatsAppMessage(
              order.phone,

              `Your AAHAAR25 order has been cancelled.\n\n` +
                `Day: ${order.day}\n` +
                `Stop: ${order.stop}`
            );
          }

          return res.json({
            success: true,
            refunded: false,
            order:
              updated.rows[0],
          });
        }

        /*
        Paid order:
        retrieve payment and refund it.
        */

        const payment =
          await getSquarePayment(
            order.square_payment_id
          );

        if (
          !payment?.amount_money
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Payment amount could not be found",
          });
        }

        const refund =
          await refundSquarePayment({
            paymentId:
              order.square_payment_id,

            amountMoney:
              payment.amount_money,

            reason:
              "AAHAAR25 order cancelled by administrator",
          });

        const refundStatus =
          refund?.status || "PENDING";

        const localStatus =
          refundStatus === "COMPLETED"
            ? "refunded"
            : "refund_pending";

        const updated =
          await pool.query(
            `
            UPDATE orders
            SET status = $1
            WHERE order_id = $2
            RETURNING *
            `,
            [
              localStatus,
              orderId,
            ]
          );

        if (order.phone) {
          await sendWhatsAppMessage(
            order.phone,

            `Your AAHAAR25 order was cancelled and a refund was requested.\n\n` +
              `Day: ${order.day}\n` +
              `Stop: ${order.stop}`
          );
        }

        return res.json({
          success: true,

          refunded:
            refundStatus ===
            "COMPLETED",

          refundStatus,

          order:
            updated.rows[0],
        });
      } catch (error) {
        console.error(
          "Cancel/refund error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            "Cancel/refund failed",
        });
      }
    }
  );

  /*
  Load drivers
  */

  router.get(
    "/admin/drivers",
    requireAdmin,
    async (req, res) => {
      try {
        const result =
          await pool.query(
            `
            SELECT
              id,
              name,
              phone,
              is_active,
              created_at,
              last_login,
              phone_verified_at

            FROM drivers

            ORDER BY
              created_at DESC
            `
          );

        return res.json(
          result.rows
        );
      } catch (error) {
        console.error(
          "Load drivers error:",
          error.message
        );

        return res.status(500).json([]);
      }
    }
  );

  /*
  Add driver using current
  name/password system.

  OTP onboarding will replace this
  in the next feature stage.
  */

  router.post(
    "/admin/drivers",
    requireAdmin,
    async (req, res) => {
      try {
        const name = String(
          req.body.name || ""
        )
          .trim()
          .slice(0, 80);

        const phone = String(
          req.body.phone || ""
        )
          .trim()
          .slice(0, 30);

        const password = String(
          req.body.password || ""
        );

        if (
          !name ||
          !password ||
          password.length < 4
        ) {
          return res.status(400).json({
            success: false,

            error:
              "Driver name and a password of at least four characters are required.",
          });
        }

        const passwordHash =
          hashPassword(password);

        const result =
          await pool.query(
            `
            INSERT INTO drivers (
              name,
              phone,
              password_hash
            )
            VALUES (
              $1,
              $2,
              $3
            )

            RETURNING
              id,
              name,
              phone,
              is_active,
              created_at
            `,
            [
              name,
              phone || null,
              passwordHash,
            ]
          );

        return res.json({
          success: true,
          driver:
            result.rows[0],
        });
      } catch (error) {
        console.error(
          "Add driver error:",
          error.message
        );

        const duplicate =
          error.code === "23505";

        return res
          .status(
            duplicate ? 409 : 500
          )
          .json({
            success: false,

            error: duplicate
              ? "A driver with that name already exists."
              : "Could not add driver",
          });
      }
    }
  );

  /*
  Reactivate driver
  */

  router.post(
    "/admin/drivers/activate",
    requireAdmin,
    async (req, res) => {
      try {
        const driverId = Number(
          req.body.driverId
        );

        if (
          !Number.isInteger(driverId)
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Invalid driver",
          });
        }

        const result =
          await pool.query(
            `
            UPDATE drivers
            SET is_active = TRUE
            WHERE id = $1

            RETURNING
              id,
              name,
              phone,
              is_active
            `,
            [driverId]
          );

        if (!result.rows[0]) {
          return res.status(404).json({
            success: false,
            error:
              "Driver not found",
          });
        }

        return res.json({
          success: true,
          driver:
            result.rows[0],
        });
      } catch (error) {
        console.error(
          "Activate driver error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            "Could not activate driver",
        });
      }
    }
  );

  /*
  Deactivate driver
  */

  router.post(
    "/admin/drivers/deactivate",
    requireAdmin,
    async (req, res) => {
      try {
        const driverId = Number(
          req.body.driverId
        );

        if (
          !Number.isInteger(driverId)
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Invalid driver",
          });
        }

        const result =
          await pool.query(
            `
            UPDATE drivers
            SET is_active = FALSE
            WHERE id = $1

            RETURNING
              id,
              name,
              phone,
              is_active
            `,
            [driverId]
          );

        if (!result.rows[0]) {
          return res.status(404).json({
            success: false,
            error:
              "Driver not found",
          });
        }

        await deleteAllDriverSessions(
          pool,
          driverId
        );

        return res.json({
          success: true,
          driver:
            result.rows[0],
        });
      } catch (error) {
        console.error(
          "Deactivate driver error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            "Could not deactivate driver",
        });
      }
    }
  );

  /*
  Driver activity
  */

  router.get(
    "/admin/driver-activity",
    requireAdmin,
    async (req, res) => {
      try {
        const result =
          await pool.query(
            `
            SELECT *
            FROM driver_activity
            ORDER BY created_at DESC
            LIMIT 200
            `
          );

        return res.json(
          result.rows
        );
      } catch (error) {
        console.error(
          "Driver activity error:",
          error.message
        );

        return res.status(500).json([]);
      }
    }
  );

  /*
  Load assignments
  */

  router.get(
    "/admin/assignments",
    requireAdmin,
    async (req, res) => {
      try {
        const result =
          await pool.query(
            `
            SELECT
              driver_assignments.id,
              driver_assignments.day,
              driver_assignments.stop,
              driver_assignments.driver_id,
              drivers.name AS driver_name,

              COALESCE(
                route_progress.status,
                'not_started'
              ) AS route_status

            FROM driver_assignments

            LEFT JOIN drivers
              ON drivers.id =
                 driver_assignments.driver_id

            LEFT JOIN route_progress
              ON route_progress.day =
                 driver_assignments.day
             AND route_progress.stop =
                 driver_assignments.stop

            ORDER BY

              CASE
                driver_assignments.day
                WHEN 'Tuesday' THEN 1
                WHEN 'Wednesday' THEN 2
                WHEN 'Thursday' THEN 3
                WHEN 'Friday' THEN 4
                ELSE 5
              END,

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
            `
          );

        return res.json(
          result.rows
        );
      } catch (error) {
        console.error(
          "Load assignments error:",
          error.message
        );

        return res.status(500).json([]);
      }
    }
  );

  /*
  Create or update assignment
  */

  router.post(
    "/admin/assignments",
    requireAdmin,
    async (req, res) => {
      try {
        const allowedDays = [
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
        ];

        const allowedStops = [
          "Gateway Village",
          "Discovery Place",
          "Ally Center",
          "One Wells Fargo",
        ];

        const day = String(
          req.body.day || ""
        ).trim();

        const stop = String(
          req.body.stop || ""
        ).trim();

        const driverId =
          req.body.driverId === "" ||
          req.body.driverId === null ||
          req.body.driverId === undefined
            ? null
            : Number(
                req.body.driverId
              );

        if (
          !allowedDays.includes(day) ||
          !allowedStops.includes(stop)
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Invalid day or stop",
          });
        }

        if (
          driverId !== null &&
          !Number.isInteger(driverId)
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Invalid driver",
          });
        }

        if (driverId !== null) {
          const driverResult =
            await pool.query(
              `
              SELECT id
              FROM drivers
              WHERE id = $1
                AND is_active = TRUE
              LIMIT 1
              `,
              [driverId]
            );

          if (!driverResult.rows[0]) {
            return res.status(400).json({
              success: false,
              error:
                "Active driver not found",
            });
          }
        }

        const assignmentResult =
          await pool.query(
            `
            INSERT INTO driver_assignments (
              day,
              stop,
              driver_id
            )
            VALUES (
              $1,
              $2,
              $3
            )

            ON CONFLICT (
              day,
              stop
            )

            DO UPDATE SET
              driver_id =
                EXCLUDED.driver_id,
              updated_at = NOW()

            RETURNING *
            `,
            [
              day,
              stop,
              driverId,
            ]
          );

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
            'not_started'
          )

          ON CONFLICT (
            day,
            stop
          )

          DO UPDATE SET
            driver_id =
              EXCLUDED.driver_id,

            status =
              CASE
                WHEN
                  route_progress.driver_id
                  IS DISTINCT FROM
                  EXCLUDED.driver_id

                THEN 'not_started'

                ELSE
                  route_progress.status
              END,

            updated_at = NOW()
          `,
          [
            day,
            stop,
            driverId,
          ]
        );

        return res.json({
          success: true,
          assignment:
            assignmentResult.rows[0],
        });
      } catch (error) {
        console.error(
          "Save assignment error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            "Could not save assignment",
        });
      }
    }
  );

  return router;
}

module.exports =
  createAdminRouter;