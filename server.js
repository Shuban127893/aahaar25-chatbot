const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

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
OpenAI client
*/

const client =
  new OpenAI({
    apiKey:
      process.env.OPENAI_API_KEY,
  });

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