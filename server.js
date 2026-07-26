const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

const fs = require("fs");

const Anthropic = require("@anthropic-ai/sdk");

const pool = require(
  "./config/database"
);

const {
  initializeDatabase,
} = require(
  "./database/initializeDatabase"
);

const createAdminAuth = require(
  "./middleware/adminAuth"
);

const createDriverAuth = require(
  "./middleware/driverAuth"
);

const createWhatsAppRouter = require(
  "./routes/whatsappRoutes"
);

const createSquareRouter = require(
  "./routes/squareRoutes"
);

const createAdminRouter = require(
  "./routes/adminRoutes"
);

const createDriverRouter = require(
  "./routes/driverRoutes"
);

const {
  sendWhatsAppMessage,
} = require(
  "./services/whatsappService"
);

const {
  createSquarePaymentLink,
} = require(
  "./services/squareService"
);

const app = express();

const PORT =
  process.env.PORT || 3000;

app.set(
  "trust proxy",
  1
);

/*
Square webhook raw body.

This must stay before express.json().
*/

app.use(
  "/square-webhook",
  express.raw({
    type: "application/json",
  })
);

/*
General security middleware
*/

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
        ],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  })
);

/*
Only these origins may call the API
from a browser. Server-to-server calls
(WhatsApp, Square webhooks) don't send
an Origin header and are unaffected.

Add more origins with a comma-separated
ALLOWED_ORIGINS env var if this app is
ever embedded elsewhere.
*/

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://www.aahaar25.com,https://aahaar25.com"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/*
The admin and driver dashboards are pages
served BY this app itself, at its own Railway
domain - so that domain must always be trusted,
or the dashboards can never call their own API.

Railway sets RAILWAY_PUBLIC_DOMAIN automatically
for any service with public networking on.
*/

if (process.env.RAILWAY_PUBLIC_DOMAIN) {
  ALLOWED_ORIGINS.push(
    `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  );
}

console.log(
  "CORS allowed origins:",
  ALLOWED_ORIGINS
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        ALLOWED_ORIGINS.includes(origin)
      ) {
        return callback(null, true);
      }

      return callback(
        new Error("Not allowed by CORS")
      );
    },
  })
);

app.use(
  express.json({
    limit: "1mb",
  })
);

/*
Prevent direct access to raw admin
and driver HTML file names.
*/

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
    windowMs:
      60 * 1000,

    max: 120,

    standardHeaders: true,
    legacyHeaders: false,
  })
);

/*
Claude (Anthropic) client
*/

const client =
  new Anthropic({
    apiKey:
      process.env.ANTHROPIC_API_KEY,
  });

/*
Business data the chatbot is allowed to use.

The database is the real, persistent source
of truth, because Railway rebuilds this app's
filesystem from git on every deploy - anything
saved only to the JSON files would be lost the
next time this app is deployed.

delivery-info.json / menu-info.json are used
only once, to seed the database the very first
time this app ever starts with no saved data.
*/

const DELIVERY_INFO_PATH = path.join(
  __dirname,
  "delivery-info.json"
);

const MENU_INFO_PATH = path.join(
  __dirname,
  "menu-info.json"
);

let deliveryInfo = JSON.parse(
  fs.readFileSync(
    DELIVERY_INFO_PATH,
    "utf8"
  )
);

let menuInfo = JSON.parse(
  fs.readFileSync(
    MENU_INFO_PATH,
    "utf8"
  )
);

async function loadBusinessDataFromDb() {
  const result = await pool.query(
    `SELECT key, value FROM business_data
     WHERE key IN ('delivery_info', 'menu_info');`
  );

  const rows = {};

  for (const row of result.rows) {
    rows[row.key] = row.value;
  }

  if (rows.delivery_info) {
    deliveryInfo = JSON.parse(
      rows.delivery_info
    );
  } else {
    // First-ever boot: seed the database
    // from the JSON file that shipped in git.
    await pool.query(
      `INSERT INTO business_data (key, value)
       VALUES ('delivery_info', $1)
       ON CONFLICT (key) DO NOTHING;`,
      [JSON.stringify(deliveryInfo)]
    );
  }

  if (rows.menu_info) {
    menuInfo = JSON.parse(rows.menu_info);
  } else {
    await pool.query(
      `INSERT INTO business_data (key, value)
       VALUES ('menu_info', $1)
       ON CONFLICT (key) DO NOTHING;`,
      [JSON.stringify(menuInfo)]
    );
  }
}

async function reloadBusinessData() {
  await loadBusinessDataFromDb();
}

async function saveBusinessDataToDb(
  newDeliveryInfo,
  newMenuInfo
) {
  await pool.query(
    `INSERT INTO business_data (key, value, updated_at)
     VALUES ('delivery_info', $1, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = $1, updated_at = NOW();`,
    [JSON.stringify(newDeliveryInfo)]
  );

  await pool.query(
    `INSERT INTO business_data (key, value, updated_at)
     VALUES ('menu_info', $1, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = $1, updated_at = NOW();`,
    [JSON.stringify(newMenuInfo)]
  );

  deliveryInfo = newDeliveryInfo;
  menuInfo = newMenuInfo;
}

function buildSystemPrompt() {
  return `You are the AAHAAR25 restaurant assistant.

Answer customer questions ONLY using the delivery and menu information provided below. Never invent delivery stops, prices, times, or menu items that are not listed here.

If a customer asks about a delivery location that is not listed, respond politely using this message: "${deliveryInfo.unsupportedLocationResponse}"

Keep answers short, friendly, and accurate. If you don't have enough information to answer, tell the customer to call ${deliveryInfo.phone}.

DELIVERY INFORMATION:
${JSON.stringify(deliveryInfo, null, 2)}

MENU INFORMATION:
${JSON.stringify(menuInfo, null, 2)}`;
}


/*
Cookie helpers shared with the route
and authentication modules.
*/

function getCookie(req, name) {
  const cookies =
    req.headers.cookie || "";

  const match =
    cookies.match(
      new RegExp(
        `(^| )${name}=([^;]+)`
      )
    );

  return match
    ? decodeURIComponent(
        match[2]
      )
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
      "HttpOnly; " +
      "Secure; " +
      "SameSite=Lax; " +
      "Path=/; " +
      `Max-Age=${maxAgeSeconds}`
  );
}

function clearCookie(
  res,
  name
) {
  res.setHeader(
    "Set-Cookie",

    `${name}=; ` +
      "HttpOnly; " +
      "Secure; " +
      "SameSite=Lax; " +
      "Path=/; " +
      "Max-Age=0"
  );
}

/*
Authentication middleware
*/

const {
  requireAdmin,
  requireAdminPage,
} = createAdminAuth({
  pool,
  getCookie,

  adminApiKey:
    process.env.ADMIN_API_KEY,
});

const {
  requireDriver,
} = createDriverAuth({
  pool,
  getCookie,

  driverApiKey:
    process.env.DRIVER_API_KEY,
});

/*
Order helper passed to WhatsApp route
*/

function generateOrderId() {
  return (
    "AAH-" +
    crypto.randomUUID()
  );
}

/*
Public health route
*/

app.get("/", (req, res) => {
  return res.send(
    "AAHAAR25 Version 2 backend is running."
  );
});

/*
Public login pages
*/

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

/*
Website chatbot route

This remains in server.js for now.
It can later move into chatRoutes.js.
*/

const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,

  max: 20,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,

    error:
      "Too many messages. Please wait a few minutes and try again.",
  },
});

app.post(
  "/chat",
  chatLimiter,
  async (req, res) => {
    try {
      const userMessage =
        String(
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
        await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system: buildSystemPrompt(),
          messages: [
            {
              role: "user",
              content: userMessage,
            },
          ],
        });

      const replyText = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      return res.json({
        reply: replyText,
      });
    } catch (error) {
      console.error(
        "Chat error:",
        error.message
      );

      return res.status(500).json({
        reply:
          "Sorry, something went wrong. Please call AAHAAR25 directly.",
      });
    }
  }
);

/*
WhatsApp customer-ordering routes
*/

app.use(
  createWhatsAppRouter({
    pool,
    createSquarePaymentLink,
    generateOrderId,
    client,
    buildSystemPrompt,
    getDeliveryInfo: () => deliveryInfo,
  })
);

/*
Square webhook routes
*/

app.use(
  "/square-webhook",

  createSquareRouter({
    pool,
    sendWhatsAppMessage,
  })
);

/*
Admin routes
*/

app.use(
  createAdminRouter({
    pool,
    requireAdmin,
    requireAdminPage,
    getCookie,
    setCookie,
    clearCookie,
    sendWhatsAppMessage,
    getDeliveryInfo: () => deliveryInfo,
    getMenuInfo: () => menuInfo,
    saveBusinessDataToDb,
  })
);

/*
Driver routes
*/

app.use(
  createDriverRouter({
    pool,
    requireDriver,
    getCookie,
    setCookie,
    clearCookie,
    sendWhatsAppMessage,
    getDeliveryInfo: () => deliveryInfo,
  })
);

/*
Fallback 404 response
*/

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    error:
      "Route not found",
  });
});

/*
Initialize database and start server
*/

initializeDatabase()
  .then(() =>
    loadBusinessDataFromDb()
  )
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

        console.log(
          "Stage E routes loaded"
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