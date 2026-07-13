const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

const pool = require("./config/database");
const {
  initializeDatabase,
} = require("./database/initializeDatabase");

const createWhatsAppRouter = require("./routes/whatsappRoutes");
const {
  sendWhatsAppMessage,
} = require("./services/whatsappService");

const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

/*
Square must receive the original raw request body so its webhook
signature can be verified correctly.
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

/*
Prevent people from directly opening the raw HTML filenames.
They should use /admin-login and /driver-login instead.
*/
app.use((req, res, next) => {
  if (
    req.path === "/admin.html" ||
    req.path === "/driver.html"
  ) {
    return res.status(404).send("Not found");
  }

  next();
});

app.use(express.static("public"));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* Square configuration */

const SQUARE_ACCESS_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN;

const SQUARE_LOCATION_ID =
  process.env.SQUARE_LOCATION_ID;

const SQUARE_WEBHOOK_SIGNATURE_KEY =
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

const SQUARE_ENVIRONMENT =
  process.env.SQUARE_ENVIRONMENT || "sandbox";

/* Admin and driver configuration */

const ADMIN_API_KEY =
  process.env.ADMIN_API_KEY;

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_API_KEY;

const DRIVER_API_KEY =
  process.env.DRIVER_API_KEY;

const SQUARE_BASE_URL =
  SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

const SQUARE_WEBHOOK_URL =
  "https://aahaar25-chatbot-production.up.railway.app/square-webhook";

/* Cookie helpers */

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";

  const match = cookies.match(
    new RegExp(`(^| )${name}=([^;]+)`)
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
    `${name}=${encodeURIComponent(value)}; ` +
      `HttpOnly; Secure; SameSite=Lax; ` +
      `Path=/; Max-Age=${maxAgeSeconds}`
  );
}

function clearCookie(res, name) {
  res.setHeader(
    "Set-Cookie",
    `${name}=; HttpOnly; Secure; ` +
      `SameSite=Lax; Path=/; Max-Age=0`
  );
}

/* Password helpers */

function hashPassword(password) {
  const salt = crypto
    .randomBytes(16)
    .toString("hex");

  const hash = crypto
    .pbkdf2Sync(
      password,
      salt,
      100000,
      64,
      "sha512"
    )
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) {
    return false;
  }

  const [salt, originalHash] =
    stored.split(":");

  const hash = crypto
    .pbkdf2Sync(
      password,
      salt,
      100000,
      64,
      "sha512"
    )
    .toString("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash),
      Buffer.from(originalHash)
    );
  } catch {
    return false;
  }
}

/* Admin authentication */

async function requireAdmin(
  req,
  res,
  next
) {
  try {
    if (
      ADMIN_API_KEY &&
      req.headers["x-admin-key"] ===
        ADMIN_API_KEY
    ) {
      return next();
    }

    const token = getCookie(
      req,
      "admin_session"
    );

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Admin login required",
      });
    }

    const result = await pool.query(
      `
      SELECT token
      FROM admin_sessions
      WHERE token = $1
        AND expires_at > NOW()
      LIMIT 1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: "Invalid admin session",
      });
    }

    return next();
  } catch (error) {
    console.error(
      "Admin authentication error:",
      error.message
    );

    return res.status(401).json({
      success: false,
      error: "Admin authentication failed",
    });
  }
}

async function requireAdminPage(
  req,
  res,
  next
) {
  try {
    const token = getCookie(
      req,
      "admin_session"
    );

    if (!token) {
      return res.redirect("/admin-login");
    }

    const result = await pool.query(
      `
      SELECT token
      FROM admin_sessions
      WHERE token = $1
        AND expires_at > NOW()
      LIMIT 1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.redirect("/admin-login");
    }

    return next();
  } catch (error) {
    console.error(
      "Admin page authentication error:",
      error.message
    );

    return res.redirect("/admin-login");
  }
}

/* Driver authentication */

async function requireDriver(
  req,
  res,
  next
) {
  try {
    if (
      DRIVER_API_KEY &&
      req.headers["x-driver-key"] ===
        DRIVER_API_KEY
    ) {
      return next();
    }

    const authorization =
      req.headers.authorization || "";

    const bearerToken =
      authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

    const token =
      bearerToken ||
      getCookie(req, "driver_session");

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Driver login required",
      });
    }

    const result = await pool.query(
      `
      SELECT drivers.*
      FROM driver_sessions
      JOIN drivers
        ON drivers.id =
           driver_sessions.driver_id
      WHERE driver_sessions.token = $1
        AND driver_sessions.expires_at > NOW()
        AND drivers.is_active = TRUE
      LIMIT 1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error:
          "Invalid or expired driver session",
      });
    }

    req.driver = result.rows[0];

    return next();
  } catch (error) {
    console.error(
      "Driver authentication error:",
      error.message
    );

    return res.status(401).json({
      success: false,
      error: "Driver authentication failed",
    });
  }
}

/* General helpers */

function generateOrderId() {
  return `AAH-${crypto.randomUUID()}`;
}

function normalizeDay(text = "") {
  const lower = text
    .trim()
    .toLowerCase();

  if (
    lower.includes("tuesday") ||
    lower === "tue"
  ) {
    return "Tuesday";
  }

  if (
    lower.includes("wednesday") ||
    lower === "wed"
  ) {
    return "Wednesday";
  }

  if (
    lower.includes("thursday") ||
    lower === "thu"
  ) {
    return "Thursday";
  }

  if (
    lower.includes("friday") ||
    lower === "fri"
  ) {
    return "Friday";
  }

  return null;
}

function normalizeStop(text = "") {
  const lower = text
    .trim()
    .toLowerCase();

  if (lower.includes("gateway")) {
    return "Gateway Village";
  }

  if (lower.includes("discovery")) {
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

/* Square service functions
   These stay here until Stage C.
*/

async function squareRequest(
  endpoint,
  method = "GET",
  body = null
) {
  if (!SQUARE_ACCESS_TOKEN) {
    throw new Error(
      "SQUARE_ACCESS_TOKEN is missing"
    );
  }

  const response = await fetch(
    `${SQUARE_BASE_URL}${endpoint}`,
    {
      method,
      headers: {
        "Square-Version": "2026-05-20",
        Authorization:
          `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body
        ? JSON.stringify(body)
        : undefined,
    }
  );

  let data = {};

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    console.error(
      "Square API error:",
      response.status,
      JSON.stringify(data)
    );

    throw new Error(
      "Square API request failed"
    );
  }

  return data;
}

async function createSquarePaymentLink(
  order
) {
  if (!SQUARE_LOCATION_ID) {
    throw new Error(
      "SQUARE_LOCATION_ID is missing"
    );
  }

  const body = {
    idempotency_key: order.order_id,

    description:
      `AAHAAR25 Lunch Box - ${order.name}`,

    order: {
      location_id: SQUARE_LOCATION_ID,

      reference_id: order.order_id,

      metadata: {
        orderId: order.order_id,
        customerName: order.name,
        phone: order.phone,
        day: order.day,
        stop: order.stop,
      },

      line_items: [
        {
          name:
            `AAHAAR25 Lunch Box - ` +
            `${order.stop}`,

          quantity: "1",

          base_price_money: {
            amount: 1399,
            currency: "USD",
          },
        },
      ],
    },

    checkout_options: {
      allow_tipping: false,

      redirect_url:
        "https://aahaar25-chatbot-production.up.railway.app",
    },

    payment_note:
      `AAHAAR25 order ${order.order_id}`,
  };

  const data = await squareRequest(
    "/v2/online-checkout/payment-links",
    "POST",
    body
  );

  const paymentLink =
    data.payment_link;

  if (!paymentLink?.url) {
    throw new Error(
      "Square did not return a payment link"
    );
  }

  return {
    url: paymentLink.url,

    paymentLinkId:
      paymentLink.id || null,

    squareOrderId:
      paymentLink.order_id || null,
  };
}

function verifySquareSignature(
  rawBody,
  signatureHeader
) {
  if (
    !SQUARE_WEBHOOK_SIGNATURE_KEY ||
    !signatureHeader
  ) {
    return false;
  }

  const hmac = crypto.createHmac(
    "sha256",
    SQUARE_WEBHOOK_SIGNATURE_KEY
  );

  hmac.update(
    SQUARE_WEBHOOK_URL +
      rawBody.toString("utf8")
  );

  const expectedDigest =
    hmac.digest("base64");

  const expectedBuffer =
    Buffer.from(expectedDigest);

  const receivedBuffer =
    Buffer.from(signatureHeader);

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

/* Main pages */

app.get("/", (req, res) => {
  res.send(
    "Ahaar25 chatbot backend is running " +
      "with PostgreSQL orders and " +
      "refactored WhatsApp routes."
  );
});

app.get("/admin-login", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "admin.html"
    )
  );
});

app.get(
  "/admin",
  requireAdminPage,
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "admin.html"
      )
    );
  }
);

app.get("/driver-login", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "driver.html"
    )
  );
});

app.get("/driver", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "driver.html"
    )
  );
});

/* Admin login */

app.post("/admin/login", async (req, res) => {
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
        error: "Invalid admin password",
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
      error: "Admin login failed",
    });
  }
});

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
  async (req, res) => {
    try {
      const name = String(
        req.body.name || ""
      ).trim();

      const password = String(
        req.body.password || ""
      );

      const result = await pool.query(
        `
        SELECT *
        FROM drivers
        WHERE LOWER(name) = LOWER($1)
          AND is_active = TRUE
        LIMIT 1
        `,
        [name]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error: "Invalid login",
        });
      }

      const driver = result.rows[0];

      if (
        !verifyPassword(
          password,
          driver.password_hash
        )
      ) {
        return res.status(401).json({
          success: false,
          error: "Invalid login",
        });
      }

      const token = crypto
        .randomBytes(32)
        .toString("hex");

      await pool.query(
        `
        INSERT INTO driver_sessions (
          token,
          driver_id,
          expires_at
        )
        VALUES (
          $1,
          $2,
          NOW() + INTERVAL '8 hours'
        )
        `,
        [token, driver.id]
      );

      await pool.query(
        `
        UPDATE drivers
        SET last_login = NOW()
        WHERE id = $1
        `,
        [driver.id]
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
        error: "Driver login failed",
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

      if (token) {
        await pool.query(
          `
          DELETE FROM driver_sessions
          WHERE token = $1
          `,
          [token]
        );
      }

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

/* Square webhook
   This stays in server.js until Stage C.
*/

app.post(
  "/square-webhook",
  async (req, res) => {
    try {
      const rawBody = req.body;

      const signature =
        req.headers[
          "x-square-hmacsha256-signature"
        ];

      if (
        !verifySquareSignature(
          rawBody,
          signature
        )
      ) {
        console.warn(
          "Invalid Square webhook signature"
        );

        return res.sendStatus(401);
      }

      const event = JSON.parse(
        rawBody.toString("utf8")
      );

      if (
        event.type !== "payment.updated" &&
        event.type !== "payment.created"
      ) {
        return res.sendStatus(200);
      }

      const payment =
        event.data?.object?.payment;

      if (
        !payment ||
        payment.status !== "COMPLETED"
      ) {
        return res.sendStatus(200);
      }

      let orderResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE square_order_id = $1
             OR square_payment_id = $2
          LIMIT 1
          `,
          [
            payment.order_id,
            payment.id,
          ]
        );

      if (
        orderResult.rows.length === 0 &&
        payment.order_id
      ) {
        const squareOrderData =
          await squareRequest(
            `/v2/orders/${payment.order_id}`
          );

        const referenceId =
          squareOrderData.order
            ?.reference_id;

        if (referenceId) {
          orderResult =
            await pool.query(
              `
              SELECT *
              FROM orders
              WHERE order_id = $1
              LIMIT 1
              `,
              [referenceId]
            );
        }
      }

      if (
        orderResult.rows.length === 0
      ) {
        console.warn(
          "No matching local order found " +
            "for Square payment."
        );

        return res.sendStatus(200);
      }

      const order =
        orderResult.rows[0];

      if (
        order.status === "confirmed" ||
        order.status === "delivered"
      ) {
        return res.sendStatus(200);
      }

      const updated =
        await pool.query(
          `
          UPDATE orders
          SET
            status = 'confirmed',
            confirmed_at = NOW(),
            square_payment_id = $1,
            square_receipt_url = $2
          WHERE order_id = $3
          RETURNING *
          `,
          [
            payment.id,
            payment.receipt_url || "",
            order.order_id,
          ]
        );

      const confirmedOrder =
        updated.rows[0];

      await sendWhatsAppMessage(
        confirmedOrder.phone,

        `✅ Your AAHAAR25 order has been automatically confirmed.\n\n` +
          `Name: ${confirmedOrder.name}\n` +
          `Day: ${confirmedOrder.day}\n` +
          `Stop: ${confirmedOrder.stop}\n\n` +
          `You will receive delivery updates on WhatsApp.`
      );

      console.log(
        "Order automatically confirmed:",
        confirmedOrder.order_id
      );

      return res.sendStatus(200);
    } catch (error) {
      console.error(
        "Square webhook error:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);

/* Website chatbot */

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(
      req.body.message || ""
    )
      .trim()
      .slice(0, 1000);

    if (!userMessage) {
      return res.status(400).json({
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
      reply: response.output_text,
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
});

/*
THIS IS WHERE THE NEW WHATSAPP ROUTER IS ADDED.

The router now handles:

GET  /webhook
POST /webhook

It uses the functions you moved into:

services/whatsappService.js
routes/whatsappRoutes.js
*/

app.use(
  createWhatsAppRouter({
    pool,
    createSquarePaymentLink,
    generateOrderId,
  })
);

/* Admin order routes */

app.get(
  "/admin/orders",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT *
        FROM orders
        ORDER BY created_at DESC
        LIMIT 200
        `
      );

      return res.json(result.rows);
    } catch (error) {
      console.error(
        "Admin orders error:",
        error.message
      );

      return res.status(500).json([]);
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

        order = result.rows[0];
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
              [selected.order_id]
            );

          order = result.rows[0];
        }
      }

      if (!order) {
        return res.status(400).json({
          success: false,
          error: "Invalid order",
        });
      }

      await sendWhatsAppMessage(
        order.phone,

        `✅ Your AAHAAR25 order has been confirmed.\n\n` +
          `Day: ${order.day || "Today"}\n` +
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
        error: "Could not confirm order",
      });
    }
  }
);

/* Admin driver routes */

app.get(
  "/admin/drivers",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
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

      return res.json(result.rows);
    } catch (error) {
      console.error(
        "Load drivers error:",
        error.message
      );

      return res.status(500).json([]);
    }
  }
);

app.post(
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
            "Driver name and a password " +
            "of at least four characters " +
            "are required.",
        });
      }

      const passwordHash =
        hashPassword(password);

      const result = await pool.query(
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
        driver: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Add driver error:",
        error.message
      );

      const duplicate =
        error.code === "23505";

      return res.status(
        duplicate ? 409 : 500
      ).json({
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
      const driverId = Number(
        req.body.driverId
      );

      if (!Number.isInteger(driverId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid driver",
        });
      }

      const result = await pool.query(
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
          error: "Driver not found",
        });
      }

      await pool.query(
        `
        DELETE FROM driver_sessions
        WHERE driver_id = $1
        `,
        [driverId]
      );

      return res.json({
        success: true,
        driver: result.rows[0],
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
      const result = await pool.query(
        `
        SELECT *
        FROM driver_activity
        ORDER BY created_at DESC
        LIMIT 100
        `
      );

      return res.json(result.rows);
    } catch (error) {
      console.error(
        "Driver activity error:",
        error.message
      );

      return res.status(500).json([]);
    }
  }
);

/* Driver notification route */

app.post(
  "/driver/notify-stop",
  requireDriver,
  async (req, res) => {
    try {
      const {
        stop,
        status,
      } = req.body;

      if (!stop || !status) {
        return res.status(400).json({
          success: false,
          error:
            "Missing stop or status",
        });
      }

      const normalizedStop =
        normalizeStop(stop);

      if (!normalizedStop) {
        return res.status(400).json({
          success: false,
          error: "Invalid stop",
        });
      }

      const validStatuses = [
        "10min",
        "5min",
        "arrived",
        "delivered",
      ];

      if (
        !validStatuses.includes(status)
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid status",
        });
      }

      const result = await pool.query(
        `
        SELECT *
        FROM orders
        WHERE status = 'confirmed'
          AND LOWER(stop) = LOWER($1)
        `,
        [normalizedStop]
      );

      const customersAtStop =
        result.rows;

      if (
        customersAtStop.length === 0
      ) {
        return res.json({
          success: true,
          sentCount: 0,
          totalCustomers: 0,
          message:
            `No confirmed customers found ` +
            `for ${normalizedStop}`,
        });
      }

      const messages = {
        "10min":
          `AAHAAR25 Update: Your lunch box ` +
          `driver is about 10 minutes away ` +
          `from ${normalizedStop}.`,

        "5min":
          `AAHAAR25 Update: Your lunch box ` +
          `driver is about 5 minutes away ` +
          `from ${normalizedStop}. Please be ` +
          `ready at the delivery spot.`,

        arrived:
          `AAHAAR25 Update: Your lunch box ` +
          `driver has arrived at ` +
          `${normalizedStop}. Please meet the ` +
          `driver at the delivery spot.`,

        delivered:
          `AAHAAR25 Update: Your lunch box ` +
          `has been delivered. Thank you for ` +
          `ordering from AAHAAR25!`,
      };

      const whatsappMessage =
        messages[status];

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
            whatsappMessage
          );

        if (sendResult.ok) {
          sentCount += 1;
        }
      }

      if (status === "delivered") {
        await pool.query(
          `
          UPDATE orders
          SET
            status = 'delivered',
            delivered_at = NOW()
          WHERE status = 'confirmed'
            AND LOWER(stop) = LOWER($1)
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

/* Start server after PostgreSQL is ready */

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `Server running on port ${PORT}`
      );

      console.log("Database ready");
    });
  })
  .catch((error) => {
    console.error(
      "Database startup error full:",
      error
    );

    console.error(
      "DATABASE_URL exists:",
      Boolean(process.env.DATABASE_URL)
    );

    process.exit(1);
  });