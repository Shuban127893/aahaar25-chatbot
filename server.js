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

Loaded at startup, and reloadable at runtime
whenever an admin saves an edit through the
"Menu & delivery" admin tab, so the chatbot
never needs a redeploy to pick up a change.
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

function reloadBusinessData() {
  deliveryInfo = JSON.parse(
    fs.readFileSync(
      DELIVERY_INFO_PATH,
      "utf8"
    )
  );

  menuInfo = JSON.parse(
    fs.readFileSync(
      MENU_INFO_PATH,
      "utf8"
    )
  );
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
    DELIVERY_INFO_PATH,
    MENU_INFO_PATH,
    reloadBusinessData,
    getDeliveryInfo: () => deliveryInfo,
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