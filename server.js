const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require(
  "express-rate-limit"
);

require("dotenv").config();

const OpenAI = require("openai");

const pool = require(
  "./config/database"
);

const {
  initializeDatabase,
} = require(
  "./database/initializeDatabase"
);

const createWhatsAppRouter = require(
  "./routes/whatsappRoutes"
);

const createSquareRouter = require(
  "./routes/squareRoutes"
);

const createAdminAuth = require(
  "./middleware/adminAuth"
);

const createDriverAuth = require(
  "./middleware/driverAuth"
);

const {
  sendWhatsAppMessage,
} = require(
  "./services/whatsappService"
);

const {
  createSquarePaymentLink,
  getSquarePayment,
  refundSquarePayment,
} = require(
  "./services/squareService"
);

const {
  hashPassword,
  authenticateDriver,
  createDriverSession,
  deleteDriverSession,
  deleteAllDriverSessions,
} = require(
  "./services/driverAuthService"
);

const app = express();

const PORT =
  process.env.PORT || 3000;

app.set("trust proxy", 1);

/*
Square needs the exact raw request body.
This must stay above express.json().
*/
app.use(
  "/square-webhook",
  express.raw({
    type: "application/json",
  })
);

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(cors());

app.use(
  express.json({
    limit: "1mb",
  })
);

app.use((req, res, next) => {
  if (
    req.path === "/admin.html" ||
    req.path === "/driver.html"
  ) {
    return res
      .status(404)
      .send("Not found");
  }

  return next();
});

app.use(
  express.static("public")
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const client = new OpenAI({
  apiKey:
    process.env.OPENAI_API_KEY,
});

const ADMIN_API_KEY =
  process.env.ADMIN_API_KEY;

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_API_KEY;

const DRIVER_API_KEY =
  process.env.DRIVER_API_KEY;

/* Cookie helpers */

function getCookie(req, name) {
  const cookies =
    req.headers.cookie || "";

  const match = cookies.match(
    new RegExp(
      `(^| )${name}=([^;]+)`
    )
  );

  return match
    ? decodeURIComponent(match[2])
    : null;
}

function setCookie(
  res,
  name,
  value,
  maxAgeSeconds
) {
  res.setHeader(
    "Set-Cookie",

    `${name}=${encodeURIComponent(
      value
    )}; ` +
      "HttpOnly; Secure; " +
      "SameSite=Lax; Path=/; " +
      `Max-Age=${maxAgeSeconds}`
  );
}

function clearCookie(
  res,
  name
) {
  res.setHeader(
    "Set-Cookie",

    `${name}=; HttpOnly; ` +
      "Secure; SameSite=Lax; " +
      "Path=/; Max-Age=0"
  );
}

/* Imported authentication middleware */

const {
  requireAdmin,
  requireAdminPage,
} = createAdminAuth({
  pool,
  getCookie,
  adminApiKey:
    ADMIN_API_KEY,
});

const {
  requireDriver,
} = createDriverAuth({
  pool,
  getCookie,
  driverApiKey:
    DRIVER_API_KEY,
});

/* General helpers */

function generateOrderId() {
  return (
    "AAH-" +
    crypto.randomUUID()
  );
}

function normalizeStop(
  text = ""
) {
  const lower = String(text)
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

  if (lower.includes("ally")) {
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

/* Public pages */

app.get("/", (req, res) => {
  return res.send(
    "AAHAAR25 backend is running " +
      "with PostgreSQL, WhatsApp, " +
      "Square, and refactored authentication."
  );
});

app.get(
  "/admin-login",
  (req, res) => {
    return res.sendFile(
      path.join(
        __dirname,
        "public",
        "admin.html"
      )
    );
  }
);

app.get(
  "/admin",
  requireAdminPage,
  (req, res) => {
    return res.sendFile(
      path.join(
        __dirname,
        "public",
        "admin.html"
      )
    );
  }
);

app.get(
  "/driver-login",
  (req, res) => {
    return res.sendFile(
      path.join(
        __dirname,
        "public",
        "driver.html"
      )
    );
  }
);

app.get(
  "/driver",
  (req, res) => {
    return res.sendFile(
      path.join(
        __dirname,
        "public",
        "driver.html"
      )
    );
  }
);

/* Admin login */

app.post(
  "/admin/login",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  async (req, res) => {
    try {
      const password =
        String(
          req.body.password || ""
        );

      if (
        !ADMIN_PASSWORD ||
        password !==
          ADMIN_PASSWORD
      ) {
        return res
          .status(401)
          .json({
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

app.post(
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

/* Driver login */

app.post(
  "/driver/login",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  async (req, res) => {
    try {
      const driver =
        await authenticateDriver(
          pool,
          req.body.name,
          req.body.password
        );

      if (!driver) {
        return res
          .status(401)
          .json({
            success: false,
            error: "Invalid login",
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

app.post(
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

/* Website chatbot */

app.post(
  "/chat",
  async (req, res) => {
    try {
      const userMessage =
        String(
          req.body.message || ""
        )
          .trim()
          .slice(0, 1000);

      if (!userMessage) {
        return res
          .status(400)
          .json({
            reply:
              "Please enter a message.",
          });
      }

      const response =
        await client.responses.create({
          model: "gpt-4o-mini",
          input: userMessage,
          max_output_tokens: 300,
        });

      return res.json({
        reply:
          response.output_text,
      });
    } catch (error) {
      console.error(
        "Chat error:",
        error.message
      );

      return res.status(500).json({
        reply:
          "Sorry, something went wrong. " +
          "Please call AAHAAR25 directly.",
      });
    }
  }
);

/* WhatsApp router */

app.use(
  createWhatsAppRouter({
    pool,
    createSquarePaymentLink,
    generateOrderId,
  })
);

/* Square webhook router */

app.use(
  "/square-webhook",
  createSquareRouter({
    pool,
    sendWhatsAppMessage,
  })
);

/* Admin order routes */

app.get(
  "/admin/orders",
  requireAdmin,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT *
          FROM orders
          ORDER BY created_at DESC
          LIMIT 200
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

app.post(
  "/admin/confirm-order",
  requireAdmin,
  async (req, res) => {
    try {
      const {
        orderId,
        index,
      } = req.body;

      let order = null;

      if (orderId) {
        const result =
          await pool.query(
            `
            UPDATE orders
            SET
              status = 'confirmed',
              confirmed_at = NOW()
            WHERE order_id = $1
            RETURNING *
            `,
            [orderId]
          );

        order =
          result.rows[0];
      } else if (
        index !== undefined
      ) {
        const list =
          await pool.query(
            `
            SELECT *
            FROM orders
            ORDER BY created_at DESC
            LIMIT 200
            `
          );

        const selected =
          list.rows[index];

        if (selected) {
          const result =
            await pool.query(
              `
              UPDATE orders
              SET
                status = 'confirmed',
                confirmed_at = NOW()
              WHERE order_id = $1
              RETURNING *
              `,
              [
                selected.order_id,
              ]
            );

          order =
            result.rows[0];
        }
      }

      if (!order) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Invalid order",
          });
      }

      await sendWhatsAppMessage(
        order.phone,

        `✅ Your AAHAAR25 order has been confirmed.\n\n` +
          `Day: ${
            order.day || "Today"
          }\n` +
          `Stop: ${order.stop}\n\n` +
          `You will receive delivery updates on WhatsApp.`
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

app.post(
  "/admin/cancel-order",
  requireAdmin,
  async (req, res) => {
    try {
      const orderId =
        String(
          req.body.orderId || ""
        ).trim();

      if (!orderId) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Missing order ID",
          });
      }

      const result =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE order_id = $1
          LIMIT 1
          `,
          [orderId]
        );

      if (
        result.rows.length === 0
      ) {
        return res
          .status(404)
          .json({
            success: false,
            error:
              "Order not found",
          });
      }

      const order =
        result.rows[0];

      if (
        order.status ===
          "cancelled" ||
        order.status ===
          "refunded"
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Order is already closed",
          });
      }

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

      const payment =
        await getSquarePayment(
          order.square_payment_id
        );

      if (
        !payment?.amount_money
      ) {
        return res
          .status(400)
          .json({
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
        });

      const refundStatus =
        refund?.status ||
        "PENDING";

      const localStatus =
        refundStatus ===
        "COMPLETED"
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

/* Driver management */

app.get(
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
            last_login
          FROM drivers
          ORDER BY created_at DESC
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

app.post(
  "/admin/drivers",
  requireAdmin,
  async (req, res) => {
    try {
      const name =
        String(
          req.body.name || ""
        )
          .trim()
          .slice(0, 80);

      const phone =
        String(
          req.body.phone || ""
        )
          .trim()
          .slice(0, 30);

      const password =
        String(
          req.body.password || ""
        );

      if (
        !name ||
        !password ||
        password.length < 4
      ) {
        return res
          .status(400)
          .json({
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
          duplicate
            ? 409
            : 500
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

app.post(
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
        return res
          .status(400)
          .json({
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
        return res
          .status(404)
          .json({
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

app.get(
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
          LIMIT 100
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

/* Driver notifications */

app.post(
  "/driver/notify-stop",
  requireDriver,
  async (req, res) => {
    try {
      const {
        stop,
        status,
      } = req.body;

      if (
        !stop ||
        !status
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Missing stop or status",
          });
      }

      const normalizedStop =
        normalizeStop(stop);

      if (!normalizedStop) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Invalid stop",
          });
      }

      const validStatuses = [
        "10min",
        "5min",
        "arrived",
        "delivered",
      ];

      if (
        !validStatuses.includes(
          status
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Invalid status",
          });
      }

      const result =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE status = 'confirmed'
            AND LOWER(stop) =
                LOWER($1)
          `,
          [normalizedStop]
        );

      const customersAtStop =
        result.rows;

      if (
        customersAtStop.length ===
        0
      ) {
        return res.json({
          success: true,
          sentCount: 0,
          totalCustomers: 0,

          message:
            `No confirmed customers found for ${normalizedStop}`,
        });
      }

      const messages = {
        "10min":
          `AAHAAR25 Update: Your lunch box driver is about 10 minutes away from ${normalizedStop}.`,

        "5min":
          `AAHAAR25 Update: Your lunch box driver is about 5 minutes away from ${normalizedStop}. Please be ready at the delivery spot.`,

        arrived:
          `AAHAAR25 Update: Your lunch box driver has arrived at ${normalizedStop}. Please meet the driver at the delivery spot.`,

        delivered:
          "AAHAAR25 Update: Your lunch box has been delivered. Thank you for ordering from AAHAAR25!",
      };

      let sentCount = 0;

      for (
        const customer of
        customersAtStop
      ) {
        if (!customer.phone) {
          continue;
        }

        const sendResult =
          await sendWhatsAppMessage(
            customer.phone,
            messages[status]
          );

        if (sendResult.ok) {
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
          WHERE status = 'confirmed'
            AND LOWER(stop) =
                LOWER($1)
          `,
          [normalizedStop]
        );
      }

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
            $3,
            $4,
            $5,
            $6
          )
          `,
          [
            req.driver.id,
            req.driver.name,
            "notify_stop",
            normalizedStop,
            status,
            sentCount,
          ]
        );
      }

      return res.json({
        success: true,
        stop: normalizedStop,
        status,
        sentCount,

        totalCustomers:
          customersAtStop.length,
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

/* Start server */

initializeDatabase()
  .then(() => {
    app.listen(
      PORT,
      () => {
        console.log(
          `Server running on port ${PORT}`
        );

        console.log(
          "Database ready"
        );
      }
    );
  })
  .catch((error) => {
    console.error(
      "Database startup error full:",
      error
    );

    console.error(
      "DATABASE_URL exists:",
      Boolean(
        process.env.DATABASE_URL
      )
    );

    process.exit(1);
  });