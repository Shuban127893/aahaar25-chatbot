const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const {
  verify: verifyTotp,
  generateSecret: generateTotpSecret,
  generateURI: generateTotpURI,
} = require("otplib");

const {
  getTodayInfo,
} = require("../utils/dateHelpers");

const {
  normalizeDeliveryInfo,
  normalizeMenuInfo,
} = require("../utils/businessDataNormalization");

const {
  sendTrackingLink,
} = require("../services/whatsappService");

const {
  APP_BASE_URL,
} = require("../services/squareService");

const {
  buildTrackingToken,
} = require("./trackingRoutes");

/*
Basic schema checks for the delivery and
menu data an admin edits by hand.

These catch the mistakes a typo is likely
to cause (a blank stop name, a price that
isn't really a price) without being so
strict that a legitimate edit gets rejected.
*/

const TIME_PATTERN =
  /\d{1,2}(:\d{2})?\s*(AM|PM)/i;

const PRICE_PATTERN =
  /^\$\d+(\.\d{2})?$/;

function validateDeliveryInfo(data) {
  if (
    !data ||
    typeof data !== "object"
  ) {
    return "Delivery info must be a JSON object.";
  }

  if (
    !String(
      data.phone || ""
    ).trim()
  ) {
    return "Delivery info is missing a phone number.";
  }

  if (
    !String(
      data.unsupportedLocationResponse || ""
    ).trim()
  ) {
    return "Delivery info is missing the unsupportedLocationResponse message.";
  }

  if (
    !Array.isArray(
      data.deliveryStops
    )
  ) {
    return "deliveryStops must be a list.";
  }

  for (
    let i = 0;
    i < data.deliveryStops.length;
    i++
  ) {
    const stop =
      data.deliveryStops[i];

    if (
      !stop ||
      typeof stop !== "object"
    ) {
      return `deliveryStops[${i}] must be an object.`;
    }

    if (
      !String(
        stop.day || ""
      ).trim()
    ) {
      return `deliveryStops[${i}] is missing a day.`;
    }

    if (
      !String(
        stop.location || ""
      ).trim()
    ) {
      return `deliveryStops[${i}] is missing a location name.`;
    }

    if (
      !String(
        stop.time || ""
      ).trim()
    ) {
      return `deliveryStops[${i}] (${stop.location}) is missing a time.`;
    }

    if (
      !TIME_PATTERN.test(
        String(stop.time)
      )
    ) {
      return `deliveryStops[${i}] (${stop.location}) has a time that doesn't look valid: "${stop.time}". Use a format like "11:30 AM" or "12:00 PM - 12:15 PM".`;
    }
  }

  return null;
}

function validateMenuInfo(data) {
  if (
    !data ||
    typeof data !== "object"
  ) {
    return "Menu info must be a JSON object.";
  }

  if (
    !data.categories ||
    typeof data.categories !== "object"
  ) {
    return "Menu info must have a categories object.";
  }

  const categoryNames = Object.keys(
    data.categories
  );

  for (
    const categoryName of categoryNames
  ) {
    const items =
      data.categories[categoryName];

    if (!Array.isArray(items)) {
      return `Category "${categoryName}" must be a list of items.`;
    }

    for (
      let i = 0;
      i < items.length;
      i++
    ) {
      const item = items[i];

      if (
        !item ||
        typeof item !== "object"
      ) {
        return `${categoryName}[${i}] must be an object.`;
      }

      if (
        !String(
          item.name || ""
        ).trim()
      ) {
        return `${categoryName}[${i}] is missing a name.`;
      }

      if (
        !String(
          item.price || ""
        ).trim()
      ) {
        return `"${item.name}" in ${categoryName} is missing a price.`;
      }

      if (
        !PRICE_PATTERN.test(
          String(item.price).trim()
        )
      ) {
        return `"${item.name}" in ${categoryName} has an invalid price: "${item.price}". Use a format like "$9.99".`;
      }
    }
  }

  return null;
}

const {
  normalizePhone,
  driverPhoneExists,
  deleteAllDriverSessions,
  deleteAllDriverLoginCodes,
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
  getDeliveryInfo,
  getMenuInfo,
  saveBusinessDataToDb,
  otpSecret,
}) {
  const router = express.Router();

  /*
  Writes one entry to the permanent security
  audit log. Never allowed to break the
  actual request it's logging - if writing
  the log entry itself fails for some reason,
  that failure is only logged to the console,
  never surfaced to the person using the app.
  */
  async function logAuditEvent(
    req,
    action,
    details = {}
  ) {
    try {
      const ipAddress =
        req.headers["x-forwarded-for"] ||
        req.socket?.remoteAddress ||
        null;

      await pool.query(
        `
        INSERT INTO admin_audit_log (
          action,
          details,
          ip_address
        )
        VALUES ($1, $2, $3)
        `,
        [
          action,
          JSON.stringify(details),
          ipAddress,
        ]
      );
    } catch (error) {
      console.error(
        "Audit log write failed:",
        error.message
      );
    }
  }

  /*
  ADMIN_PASSWORD is for logging into the
  dashboard as a human.

  ADMIN_API_KEY (used in adminAuth.js via
  the x-admin-key header) is a separate,
  non-expiring credential meant only for
  server-to-server or programmatic access.

  These are kept intentionally distinct:
  a leaked API key should never also work
  as a human login, and vice versa.
  */

  const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD;

  const adminLoginLimiter =
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
          await logAuditEvent(
            req,
            "admin_login_failed",
            { reason: "wrong_password" }
          );

          return res.status(401).json({
            success: false,

            error:
              "Invalid admin password",
          });
        }

        /*
        If ADMIN_TOTP_SECRET is set, a second
        factor is required on top of the
        password. If it's not set, 2FA is
        simply not configured yet - login
        works with just the password, exactly
        as before.
        */

        const totpSecret = String(
          process.env.ADMIN_TOTP_SECRET || ""
        ).trim();

        if (totpSecret) {
          const totpCode = String(
            req.body.totpCode || ""
          ).trim();

          if (!totpCode) {
            return res.status(401).json({
              success: false,
              requiresTotp: true,

              error:
                "Enter your 2FA code to continue",
            });
          }

          const totpResult =
            await verifyTotp({
              secret: totpSecret,
              token: totpCode,
            });

          if (!totpResult.valid) {
            await logAuditEvent(
              req,
              "admin_login_failed",
              { reason: "wrong_totp" }
            );

            return res.status(401).json({
              success: false,
              requiresTotp: true,

              error:
                "Invalid 2FA code",
            });
          }
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

        await logAuditEvent(
          req,
          "admin_login_success"
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
        const token =
          getCookie(
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

        await logAuditEvent(
          req,
          "admin_logout"
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
        const result =
          await pool.query(
            `
            SELECT
              COUNT(*)::int
                AS total_orders,

              COUNT(*) FILTER (
                WHERE status = 'pending'
              )::int
                AS pending_orders,

              COUNT(*) FILTER (
                WHERE status = 'confirmed'
              )::int
                AS confirmed_orders,

              COUNT(*) FILTER (
                WHERE status = 'delivered'
              )::int
                AS delivered_orders,

              COUNT(*) FILTER (
                WHERE status = 'cancelled'
              )::int
                AS cancelled_orders,

              COUNT(*) FILTER (
                WHERE status = 'refunded'
              )::int
                AS refunded_orders,

              COALESCE(
                SUM(
                  CASE
                    WHEN status IN (
                      'confirmed',
                      'delivered'
                    )
                    THEN
                      COALESCE(
                        total_price_cents,
                        1399
                      )
                    ELSE 0
                  END
                ),
                0
              )::int
                AS revenue_cents

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

          stats:
            result.rows[0],
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
        const result =
          await pool.query(
            `
            SELECT
              orders.*,
              drivers.name
                AS assigned_driver

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

        return res
          .status(500)
          .json([]);
      }
    }
  );

  /*
  Manually confirm an order
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

        const result =
          await pool.query(
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
              }\n` +
              `Quantity: ${order.quantity || 1}\n` +
              `Total: $${((order.total_price_cents || 1399) / 100).toFixed(2)}\n\n` +
              `You will receive delivery updates on WhatsApp.`
          );

          try {
            if (order.day && order.delivery_date) {
              const dateString = new Date(
                order.delivery_date
              )
                .toISOString()
                .slice(0, 10);

              const token = buildTrackingToken(
                order.day,
                dateString,
                otpSecret
              );

              const trackingUrl =
                `${APP_BASE_URL}/track?` +
                `day=${encodeURIComponent(order.day)}` +
                `&date=${encodeURIComponent(dateString)}` +
                `&token=${token}`;

              await sendTrackingLink(
                order.phone,
                trackingUrl,
                order.day
              );
            }
          } catch (error) {
            console.error(
              "Tracking link send failed (non-blocking):",
              error.message
            );
          }
        }

        await logAuditEvent(
          req,
          "order_confirmed_manually",
          { orderId: order.order_id }
        );

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
  Cancel or refund an order
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
        Unpaid orders can be cancelled
        without contacting Square.
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
                `Day: ${
                  order.day || ""
                }\n` +
                `Stop: ${
                  order.stop || ""
                }`
            );
          }

          await logAuditEvent(
            req,
            "order_cancelled_unpaid",
            { orderId }
          );

          return res.json({
            success: true,
            refunded: false,

            order:
              updated.rows[0],
          });
        }

        /*
        Paid orders require a Square
        refund request.
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
              `Day: ${
                order.day || ""
              }\n` +
              `Stop: ${
                order.stop || ""
              }`
          );
        }

        await logAuditEvent(
          req,
          "order_refunded",
          {
            orderId,
            amountCents:
              payment.amount_money?.amount,
            refundStatus,
          }
        );

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
  Load all drivers
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
              is_active DESC,
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

        return res
          .status(500)
          .json([]);
      }
    }
  );

  /*
  Add a driver.

  Only the driver's name and WhatsApp
  phone number are required.

  Drivers authenticate using temporary
  WhatsApp codes instead of passwords.
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

        const submittedPhone =
          String(
            req.body.phone || ""
          ).trim();

        const phone =
          normalizePhone(
            submittedPhone
          );

        if (!name) {
          return res.status(400).json({
            success: false,

            error:
              "Driver name is required.",
          });
        }

        if (
          phone.length < 10 ||
          phone.length > 15
        ) {
          return res.status(400).json({
            success: false,

            error:
              "Enter a valid driver phone number.",
          });
        }

        const phoneAlreadyExists =
          await driverPhoneExists(
            pool,
            phone
          );

        if (phoneAlreadyExists) {
          return res.status(409).json({
            success: false,

            error:
              "That phone number is already associated with another driver.",
          });
        }

        const result =
          await pool.query(
            `
            INSERT INTO drivers (
              name,
              phone,
              password_hash,
              is_active
            )
            VALUES (
              $1,
              $2,
              NULL,
              TRUE
            )

            RETURNING
              id,
              name,
              phone,
              is_active,
              created_at,
              last_login,
              phone_verified_at
            `,
            [
              name,
              phone,
            ]
          );

        await logAuditEvent(
          req,
          "driver_added",
          {
            driverId: result.rows[0].id,
            name,
          }
        );

        return res.json({
          success: true,

          driver:
            result.rows[0],

          message:
            "Driver created. They can now request a login code using this phone number.",
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
            duplicate
              ? 409
              : 500
          )
          .json({
            success: false,

            error:
              duplicate
                ? "A driver with that name already exists."
                : "Could not add driver",
          });
      }
    }
  );

  /*
  Reactivate a driver
  */

  router.post(
    "/admin/drivers/activate",
    requireAdmin,
    async (req, res) => {
      try {
        const driverId =
          Number(
            req.body.driverId
          );

        if (
          !Number.isInteger(
            driverId
          )
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
              is_active,
              created_at,
              last_login,
              phone_verified_at
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

        await logAuditEvent(
          req,
          "driver_activated",
          { driverId }
        );

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
  Deactivate a driver.

  Deactivated drivers cannot request
  login codes or access the driver panel.
  */

  router.post(
    "/admin/drivers/deactivate",
    requireAdmin,
    async (req, res) => {
      try {
        const driverId =
          Number(
            req.body.driverId
          );

        if (
          !Number.isInteger(
            driverId
          )
        ) {
          return res.status(400).json({
            success: false,

            error:
              "Invalid driver",
          });
        }

        const client =
          await pool.connect();

        try {
          await client.query(
            "BEGIN"
          );

          const result =
            await client.query(
              `
              UPDATE drivers

              SET is_active = FALSE

              WHERE id = $1

              RETURNING
                id,
                name,
                phone,
                is_active,
                created_at,
                last_login,
                phone_verified_at
              `,
              [driverId]
            );

          if (!result.rows[0]) {
            await client.query(
              "ROLLBACK"
            );

            return res.status(404).json({
              success: false,

              error:
                "Driver not found",
            });
          }

          /*
          Remove current sessions and
          temporary login codes.
          */

          await deleteAllDriverSessions(
            client,
            driverId
          );

          await deleteAllDriverLoginCodes(
            client,
            driverId
          );

          /*
          Unassign the driver from all
          future route assignments.
          */

          await client.query(
            `
            UPDATE driver_assignments

            SET
              driver_id = NULL,
              updated_at = NOW()

            WHERE driver_id = $1
            `,
            [driverId]
          );

          await client.query(
            `
            UPDATE route_progress

            SET
              driver_id = NULL,
              status = 'not_started',
              updated_at = NOW()

            WHERE driver_id = $1
            `,
            [driverId]
          );

          await client.query(
            "COMMIT"
          );

          await logAuditEvent(
            req,
            "driver_deactivated",
            { driverId }
          );

          return res.json({
            success: true,

            driver:
              result.rows[0],
          });
        } catch (error) {
          await client.query(
            "ROLLBACK"
          );

          throw error;
        } finally {
          client.release();
        }
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
  Permanently delete a deactivated
  driver.

  Active drivers must be deactivated
  first to prevent accidental deletion.
  */

  router.post(
    "/admin/drivers/delete",
    requireAdmin,
    async (req, res) => {
      const client =
        await pool.connect();

      try {
        const driverId =
          Number(
            req.body.driverId
          );

        if (
          !Number.isInteger(
            driverId
          )
        ) {
          return res.status(400).json({
            success: false,

            error:
              "Invalid driver",
          });
        }

        await client.query(
          "BEGIN"
        );

        const driverResult =
          await client.query(
            `
            SELECT
              id,
              name,
              phone,
              is_active

            FROM drivers

            WHERE id = $1

            LIMIT 1

            FOR UPDATE
            `,
            [driverId]
          );

        const driver =
          driverResult.rows[0];

        if (!driver) {
          await client.query(
            "ROLLBACK"
          );

          return res.status(404).json({
            success: false,

            error:
              "Driver not found",
          });
        }

        if (driver.is_active) {
          await client.query(
            "ROLLBACK"
          );

          return res.status(400).json({
            success: false,

            error:
              "Deactivate the driver before deleting them permanently.",
          });
        }

        /*
        These tables use foreign keys,
        but clearing route assignments
        explicitly keeps the result clear.
        */

        await client.query(
          `
          UPDATE driver_assignments

          SET
            driver_id = NULL,
            updated_at = NOW()

          WHERE driver_id = $1
          `,
          [driverId]
        );

        await client.query(
          `
          UPDATE route_progress

          SET
            driver_id = NULL,
            status = 'not_started',
            updated_at = NOW()

          WHERE driver_id = $1
          `,
          [driverId]
        );

        /*
        Keep historical driver activity,
        but detach it from the deleted
        account. The driver_name text
        remains for the activity record.
        */

        await client.query(
          `
          UPDATE driver_activity

          SET driver_id = NULL

          WHERE driver_id = $1
          `,
          [driverId]
        );

        await deleteAllDriverSessions(
          client,
          driverId
        );

        await deleteAllDriverLoginCodes(
          client,
          driverId
        );

        await client.query(
          `
          DELETE FROM drivers

          WHERE id = $1
          `,
          [driverId]
        );

        await client.query(
          "COMMIT"
        );

        await logAuditEvent(
          req,
          "driver_deleted_permanently",
          {
            driverId: driver.id,
            name: driver.name,
          }
        );

        return res.json({
          success: true,

          deletedDriver: {
            id:
              driver.id,

            name:
              driver.name,

            phone:
              driver.phone,
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
          "Delete driver error:",
          error.message
        );

        return res.status(500).json({
          success: false,

          error:
            "Could not permanently delete the driver",
        });
      } finally {
        client.release();
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

            ORDER BY
              created_at DESC

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

        return res
          .status(500)
          .json([]);
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

              drivers.name
                AS driver_name,

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
                WHEN 'Tuesday'
                  THEN 1
                WHEN 'Wednesday'
                  THEN 2
                WHEN 'Thursday'
                  THEN 3
                WHEN 'Friday'
                  THEN 4
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

        return res
          .status(500)
          .json([]);
      }
    }
  );

  /*
  Create, update, or clear one
  driver assignment
  */

  router.post(
    "/admin/assignments",
    requireAdmin,
    async (req, res) => {
      try {
        const deliveryStops =
          getDeliveryInfo()?.deliveryStops || [];

        const allowedDays = [
          ...new Set(
            deliveryStops
              .map((s) =>
                String(s.day || "").trim()
              )
              .filter(Boolean)
          ),
        ];

        const allowedStops = [
          ...new Set(
            deliveryStops
              .map((s) =>
                String(
                  s.location || ""
                ).trim()
              )
              .filter(Boolean)
          ),
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
          !allowedDays.some(
            (d) =>
              d.toLowerCase() ===
              day.toLowerCase()
          ) ||
          !allowedStops.some(
            (s) =>
              s.toLowerCase() ===
              stop.toLowerCase()
          )
        ) {
          return res.status(400).json({
            success: false,

            error:
              "Invalid day or stop",
          });
        }

        if (
          driverId !== null &&
          !Number.isInteger(
            driverId
          )
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

              WHERE
                id = $1
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

        await logAuditEvent(
          req,
          "assignment_saved",
          { day, stop, driverId }
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

  /*
  Tells the dashboard what day it actually
  is right now, in the restaurant's own
  timezone - used to highlight "today" on
  the Assignments board.
  */

  router.get(
    "/admin/today",
    requireAdmin,
    async (req, res) => {
      try {
        const today = getTodayInfo();

        return res.json({
          success: true,
          dayName: today.dayName,
          dateString: today.dateString,
        });
      } catch (error) {
        console.error(
          "Get today error:",
          error.message
        );

        return res.status(500).json({
          success: false,

          error:
            "Could not determine today's date.",
        });
      }
    }
  );

  /*
  Load recent security audit log entries -
  logins, refunds, driver changes, business
  data edits. Read-only, most recent first.
  */

  router.get(
    "/admin/audit-log",
    requireAdmin,
    async (req, res) => {
      try {
        const result = await pool.query(
          `
          SELECT *
          FROM admin_audit_log
          ORDER BY created_at DESC
          LIMIT 200
          `
        );

        return res.json(result.rows);
      } catch (error) {
        console.error(
          "Load audit log error:",
          error.message
        );

        return res.status(500).json([]);
      }
    }
  );

  /*
  Generates a brand new 2FA secret and its
  QR-code URI, for setting up an authenticator
  app (Google Authenticator, Authy, etc.).

  This does NOT save or activate anything -
  the app itself can't change its own Railway
  environment variables. The admin has to
  scan the QR / add the secret to their
  authenticator app, then manually set
  ADMIN_TOTP_SECRET in Railway to this same
  value for 2FA to actually take effect.

  Protected by requireAdmin, so this can only
  be reached by someone who already knows the
  current admin password.
  */

  router.get(
    "/admin/setup-2fa-secret",
    requireAdmin,
    async (req, res) => {
      try {
        const secret = generateTotpSecret();

        const uri = generateTotpURI({
          secret,
          issuer: "AAHAAR25 Admin",
          label: "admin",
        });

        return res.json({
          success: true,
          secret,
          uri,
        });
      } catch (error) {
        console.error(
          "Generate 2FA secret error:",
          error.message
        );

        return res.status(500).json({
          success: false,

          error:
            "Could not generate a 2FA secret",
        });
      }
    }
  );

  /*
  Load the raw delivery and menu JSON
  so the admin can edit them directly.
  */

  router.get(
    "/admin/business-data",
    requireAdmin,
    async (req, res) => {
      try {
        return res.json({
          success: true,

          delivery: JSON.stringify(
            getDeliveryInfo()
          ),

          menu: JSON.stringify(
            getMenuInfo()
          ),
        });
      } catch (error) {
        console.error(
          "Load business data error:",
          error.message
        );

        return res.status(500).json({
          success: false,

          error:
            "Could not load the delivery and menu data.",
        });
      }
    }
  );

  /*
  Save edited delivery and menu JSON.

  Both are validated as real JSON before
  anything is saved, so a typo can never
  break the live chatbot.

  Saved to the database (not just the
  filesystem), since Railway rebuilds this
  app's files from git on every deploy -
  a file-only save would be lost on the
  next deploy. The in-memory copies used
  by the chatbot are updated immediately,
  so changes take effect without a redeploy.
  */

  router.post(
    "/admin/business-data",
    requireAdmin,
    async (req, res) => {
      try {
        const deliveryText = String(
          req.body.delivery || ""
        );

        const menuText = String(
          req.body.menu || ""
        );

        let parsedDelivery;
        let parsedMenu;

        try {
          parsedDelivery = JSON.parse(
            deliveryText
          );
        } catch (error) {
          return res.status(400).json({
            success: false,

            error:
              "Delivery info is not valid JSON: " +
              error.message,
          });
        }

        try {
          parsedMenu = JSON.parse(
            menuText
          );
        } catch (error) {
          return res.status(400).json({
            success: false,

            error:
              "Menu info is not valid JSON: " +
              error.message,
          });
        }

        const normalizedDelivery =
          normalizeDeliveryInfo(
            parsedDelivery
          );

        const normalizedMenu =
          normalizeMenuInfo(parsedMenu);

        const deliveryValidationError =
          validateDeliveryInfo(
            normalizedDelivery
          );

        if (deliveryValidationError) {
          return res.status(400).json({
            success: false,
            error: deliveryValidationError,
          });
        }

        const menuValidationError =
          validateMenuInfo(
            normalizedMenu
          );

        if (menuValidationError) {
          return res.status(400).json({
            success: false,
            error: menuValidationError,
          });
        }

        await saveBusinessDataToDb(
          normalizedDelivery,
          normalizedMenu
        );

        await logAuditEvent(
          req,
          "business_data_saved"
        );

        return res.json({
          success: true,

          message:
            "Delivery and menu data saved. The chatbot is now using the updated information.",
        });
      } catch (error) {
        console.error(
          "Save business data error:",
          error.message
        );

        return res.status(500).json({
          success: false,

          error:
            "Could not save the delivery and menu data.",
        });
      }
    }
  );

  return router;
}

module.exports =
  createAdminRouter;