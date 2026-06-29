const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
require("dotenv").config();

const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

// Square webhook needs raw body BEFORE express.json()
app.use("/square-webhook", express.raw({ type: "application/json" }));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
  })
);

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || "sandbox";

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const DRIVER_API_KEY = process.env.DRIVER_API_KEY;

const SQUARE_BASE_URL =
  SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

const SQUARE_WEBHOOK_URL =
  "https://aahaar25-chatbot-production.up.railway.app/square-webhook";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const userSessions = {};

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      day TEXT,
      stop TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      square_payment_link TEXT,
      square_payment_link_id TEXT,
      square_order_id TEXT,
      square_payment_id TEXT UNIQUE,
      square_receipt_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_square_order_id ON orders(square_order_id);
  `);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return next();

  const key = req.headers["x-admin-key"];
  if (key !== ADMIN_API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  next();
}

function requireDriver(req, res, next) {
  if (!DRIVER_API_KEY) return next();

  const key = req.headers["x-driver-key"];
  if (key !== DRIVER_API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  next();
}

function generateOrderId() {
  return "AAH-" + crypto.randomUUID();
}

function normalizeDay(text = "") {
  const lower = text.toLowerCase();
  if (lower.includes("tuesday") || lower === "tue") return "Tuesday";
  if (lower.includes("wednesday") || lower === "wed") return "Wednesday";
  if (lower.includes("thursday") || lower === "thu") return "Thursday";
  if (lower.includes("friday") || lower === "fri") return "Friday";
  return null;
}

function normalizeStop(text = "") {
  const lower = text.toLowerCase();
  if (lower.includes("gateway")) return "Gateway Village";
  if (lower.includes("discovery")) return "Discovery Place";
  if (lower.includes("ally")) return "Ally Center";
  if (lower.includes("wells") || lower.includes("fargo")) return "One Wells Fargo";
  return null;
}

function getIncomingText(message) {
  if (message.type === "text") return message.text?.body?.trim() || "";

  if (message.type === "interactive") {
    const buttonReply = message.interactive?.button_reply;
    const listReply = message.interactive?.list_reply;
    if (buttonReply) return buttonReply.id || buttonReply.title || "";
    if (listReply) return listReply.id || listReply.title || "";
  }

  return "";
}

async function squareRequest(endpoint, method = "GET", body = null) {
  const response = await fetch(`${SQUARE_BASE_URL}${endpoint}`, {
    method,
    headers: {
      "Square-Version": "2026-05-20",
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Square API error:", JSON.stringify(data));
    throw new Error("Square API request failed");
  }

  return data;
}

async function createSquarePaymentLink(order) {
  const body = {
    idempotency_key: order.order_id,
    description: `AAHAAR25 Lunch Box - ${order.name}`,
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
          name: `AAHAAR25 Lunch Box - ${order.stop}`,
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
      redirect_url: "https://aahaar25-chatbot-production.up.railway.app",
    },
    payment_note: `AAHAAR25 order ${order.order_id}`,
  };

  const data = await squareRequest(
    "/v2/online-checkout/payment-links",
    "POST",
    body
  );

  return {
    url: data.payment_link?.url,
    paymentLinkId: data.payment_link?.id,
    squareOrderId: data.payment_link?.order_id,
  };
}

function verifySquareSignature(rawBody, signatureHeader) {
  if (!SQUARE_WEBHOOK_SIGNATURE_KEY || !signatureHeader) return false;

  const hmac = crypto.createHmac("sha256", SQUARE_WEBHOOK_SIGNATURE_KEY);
  hmac.update(SQUARE_WEBHOOK_URL + rawBody.toString("utf8"));
  const digest = hmac.digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(signatureHeader)
    );
  } catch {
    return false;
  }
}

async function sendWhatsAppPayload(payload) {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("WhatsApp send failed:", response.status, JSON.stringify(data));
  }

  return { ok: response.ok, data };
}

async function sendWhatsAppMessage(to, message) {
  return sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: message },
  });
}

async function sendMainMenu(to) {
  return sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "AAHAAR25 🍱" },
      body: {
        text:
          "👋 Welcome to AAHAAR25!\n\n" +
          "Fresh Uptown Lunch Boxes delivered Tuesday–Friday.\n\n" +
          "What would you like to do?",
      },
      footer: { text: "Fresh • Hygienic • Delicious" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "START_ORDER", title: "🛒 Order" } },
          { type: "reply", reply: { id: "SHOW_DELIVERY", title: "📍 Delivery" } },
          { type: "reply", reply: { id: "SHOW_PRICE", title: "💲 Price" } },
        ],
      },
    },
  });
}

async function sendDayList(to) {
  return sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "🛒 Lunch Box Order" },
      body: {
        text:
          "Great choice! 🍱\n\n" +
          "Step 1 of 3:\n" +
          "Please choose your delivery day.",
      },
      footer: { text: "Available Tuesday–Friday" },
      action: {
        button: "Choose Day",
        sections: [
          {
            title: "Delivery Days",
            rows: [
              { id: "DAY_Tuesday", title: "Tuesday", description: "Order for Tuesday delivery" },
              { id: "DAY_Wednesday", title: "Wednesday", description: "Order for Wednesday delivery" },
              { id: "DAY_Thursday", title: "Thursday", description: "Order for Thursday delivery" },
              { id: "DAY_Friday", title: "Friday", description: "Order for Friday delivery" },
            ],
          },
        ],
      },
    },
  });
}

async function sendStopList(to, day) {
  return sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: `📍 ${day} Delivery` },
      body: { text: "Step 2 of 3:\nChoose your Uptown delivery stop." },
      footer: { text: "Driver waits up to 5 minutes at each stop" },
      action: {
        button: "Choose Stop",
        sections: [
          {
            title: "Uptown Stops",
            rows: [
              { id: "STOP_Gateway Village", title: "Gateway Village", description: "11:30 AM" },
              { id: "STOP_Discovery Place", title: "Discovery Place", description: "11:45 AM" },
              { id: "STOP_Ally Center", title: "Ally Center", description: "12:00 PM" },
              { id: "STOP_One Wells Fargo", title: "One Wells Fargo", description: "12:30 PM" },
            ],
          },
        ],
      },
    },
  });
}

app.get("/", (req, res) => {
  res.send("Ahaar25 chatbot backend is running with PostgreSQL orders.");
});

app.post("/square-webhook", async (req, res) => {
  try {
    const rawBody = req.body;
    const signature = req.headers["x-square-hmacsha256-signature"];

    if (!verifySquareSignature(rawBody, signature)) {
      console.warn("Invalid Square webhook signature");
      return res.sendStatus(401);
    }

    const event = JSON.parse(rawBody.toString("utf8"));

    if (event.type !== "payment.updated" && event.type !== "payment.created") {
      return res.sendStatus(200);
    }

    const payment = event.data?.object?.payment;
    if (!payment || payment.status !== "COMPLETED") {
      return res.sendStatus(200);
    }

    let orderResult = await pool.query(
      `
      SELECT * FROM orders
      WHERE square_order_id = $1 OR square_payment_id = $2
      LIMIT 1
      `,
      [payment.order_id, payment.id]
    );

    if (orderResult.rows.length === 0 && payment.order_id) {
      const squareOrderData = await squareRequest(`/v2/orders/${payment.order_id}`);
      const referenceId = squareOrderData.order?.reference_id;

      if (referenceId) {
        orderResult = await pool.query(
          `SELECT * FROM orders WHERE order_id = $1 LIMIT 1`,
          [referenceId]
        );
      }
    }

    if (orderResult.rows.length === 0) {
      console.warn("No matching local order found for Square payment.");
      return res.sendStatus(200);
    }

    const order = orderResult.rows[0];

    if (order.status === "confirmed") {
      return res.sendStatus(200);
    }

    const updated = await pool.query(
      `
      UPDATE orders
      SET status = 'confirmed',
          confirmed_at = NOW(),
          square_payment_id = $1,
          square_receipt_url = $2
      WHERE order_id = $3
      RETURNING *
      `,
      [payment.id, payment.receipt_url || "", order.order_id]
    );

    const confirmedOrder = updated.rows[0];

    const confirmationMessage =
      `✅ Your AAHAAR25 order has been automatically confirmed.\n\n` +
      `Name: ${confirmedOrder.name}\n` +
      `Day: ${confirmedOrder.day}\n` +
      `Stop: ${confirmedOrder.stop}\n\n` +
      `You will receive delivery updates on WhatsApp.`;

    await sendWhatsAppMessage(confirmedOrder.phone, confirmationMessage);

    console.log("Order automatically confirmed:", confirmedOrder.order_id);
    res.sendStatus(200);
  } catch (error) {
    console.error("Square webhook error:", error.message);
    res.sendStatus(500);
  }
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body.message || "").slice(0, 1000);

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: userMessage,
      max_output_tokens: 300,
    });

    res.json({ reply: response.output_text });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(500).json({
      reply: "Sorry, something went wrong. Please call AAHAAR25 directly.",
    });
  }
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("WhatsApp webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const userText = getIncomingText(message);
    const lower = userText.toLowerCase();

    let session = userSessions[from];

    if (lower === "cancel") {
      delete userSessions[from];
      await sendWhatsAppMessage(from, "Your order request has been cancelled.");
      return res.sendStatus(200);
    }

    if (["hi", "hello", "hey", "menu", "start"].includes(lower)) {
      await sendMainMenu(from);
      return res.sendStatus(200);
    }

    if (userText === "SHOW_PRICE" || lower.includes("price") || lower.includes("cost")) {
      await sendWhatsAppMessage(
        from,
        "The AAHAAR25 Uptown Lunch Box is $13.99 plus applicable taxes."
      );
      await sendMainMenu(from);
      return res.sendStatus(200);
    }

    if (
      userText === "SHOW_DELIVERY" ||
      lower.includes("time") ||
      lower.includes("delivery") ||
      lower.includes("spot") ||
      lower.includes("location")
    ) {
      await sendWhatsAppMessage(
        from,
        "AAHAAR25 Uptown delivery stops are:\n\n" +
          "• Gateway Village — 11:30 AM\n" +
          "• Discovery Place — 11:45 AM\n" +
          "• Ally Center — 12:00 PM\n" +
          "• One Wells Fargo — 12:30 PM\n\n" +
          "Delivery is available Tuesday through Friday."
      );
      await sendMainMenu(from);
      return res.sendStatus(200);
    }

    if (userText === "START_ORDER" || lower.includes("order") || lower.includes("lunch box")) {
      userSessions[from] = {
        step: "ask_day",
        order: { phone: from, status: "pending" },
      };

      await sendDayList(from);
      return res.sendStatus(200);
    }

    if (session?.step === "ask_day") {
      let day = null;

      if (userText.startsWith("DAY_")) day = userText.replace("DAY_", "");
      else day = normalizeDay(userText);

      if (!day) {
        await sendDayList(from);
        return res.sendStatus(200);
      }

      session.order.day = day;
      session.step = "ask_stop";

      await sendStopList(from, day);
      return res.sendStatus(200);
    }

    if (session?.step === "ask_stop") {
      let stop = null;

      if (userText.startsWith("STOP_")) stop = userText.replace("STOP_", "");
      else stop = normalizeStop(userText);

      if (!stop) {
        await sendStopList(from, session.order.day);
        return res.sendStatus(200);
      }

      session.order.stop = stop;
      session.step = "ask_name";

      await sendWhatsAppMessage(from, "Got it. What name should we put on the order?");
      return res.sendStatus(200);
    }

    if (session?.step === "ask_name") {
      const cleanName = userText.replace(/[<>]/g, "").slice(0, 80);

      const newOrder = {
        order_id: generateOrderId(),
        name: cleanName,
        phone: session.order.phone,
        day: session.order.day,
        stop: session.order.stop,
      };

      const squareLink = await createSquarePaymentLink(newOrder);

      const inserted = await pool.query(
        `
        INSERT INTO orders (
          order_id, name, phone, day, stop, status,
          square_payment_link, square_payment_link_id, square_order_id
        )
        VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
        RETURNING *
        `,
        [
          newOrder.order_id,
          newOrder.name,
          newOrder.phone,
          newOrder.day,
          newOrder.stop,
          squareLink.url,
          squareLink.paymentLinkId,
          squareLink.squareOrderId,
        ]
      );

      const order = inserted.rows[0];

      delete userSessions[from];

      await sendWhatsAppMessage(
        from,
        `Thanks ${order.name}. Your AAHAAR25 lunch box order request has been saved as pending.\n\n` +
          `Day: ${order.day}\n` +
          `Stop: ${order.stop}\n\n` +
          `Please complete payment here:\n${order.square_payment_link}\n\n` +
          `After payment, your order should confirm automatically.`
      );

      return res.sendStatus(200);
    }

    if (lower.includes("status")) {
      const result = await pool.query(
        `
        SELECT * FROM orders
        WHERE phone = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [from]
      );

      if (result.rows.length === 0) {
        await sendWhatsAppMessage(
          from,
          "I couldn't find an order connected to this WhatsApp number. To start an order, tap Order below."
        );
        await sendMainMenu(from);
        return res.sendStatus(200);
      }

      const latestOrder = result.rows[0];

      await sendWhatsAppMessage(
        from,
        `AAHAAR25 Order Status\n\n` +
          `Status: ${latestOrder.status}\n` +
          `Day: ${latestOrder.day || "Not selected"}\n` +
          `Stop: ${latestOrder.stop || "Not selected"}`
      );

      return res.sendStatus(200);
    }

    await sendMainMenu(from);
    res.sendStatus(200);
  } catch (error) {
    console.error("WhatsApp webhook error:", error.message);
    res.sendStatus(500);
  }
});

app.post("/driver/notify-stop", requireDriver, async (req, res) => {
  try {
    const { stop, status } = req.body;

    if (!stop || !status) {
      return res.status(400).json({
        success: false,
        error: "Missing stop or status",
      });
    }

    const normalizedStop = normalizeStop(stop);

    const result = await pool.query(
      `
      SELECT * FROM orders
      WHERE status = 'confirmed'
      AND LOWER(stop) LIKE LOWER($1)
      `,
      [`%${normalizedStop.split(" ")[0]}%`]
    );

    const customersAtStop = result.rows;

    if (customersAtStop.length === 0) {
      return res.json({
        success: true,
        sentCount: 0,
        message: `No confirmed customers found for ${normalizedStop}`,
      });
    }

    let whatsappMessage = "";

    if (status === "10min") {
      whatsappMessage = `AAHAAR25 Update: Your lunch box driver is about 10 minutes away from ${normalizedStop}.`;
    } else if (status === "5min") {
      whatsappMessage = `AAHAAR25 Update: Your lunch box driver is about 5 minutes away from ${normalizedStop}. Please be ready at the delivery spot.`;
    } else if (status === "arrived") {
      whatsappMessage = `AAHAAR25 Update: Your lunch box driver has arrived at ${normalizedStop}. Please meet the driver at the delivery spot.`;
    } else if (status === "delivered") {
      whatsappMessage = `AAHAAR25 Update: Your lunch box has been delivered. Thank you for ordering from AAHAAR25!`;
    } else {
      return res.status(400).json({
        success: false,
        error: "Invalid status",
      });
    }

    let sentCount = 0;

    for (const customer of customersAtStop) {
      const result = await sendWhatsAppMessage(customer.phone, whatsappMessage);
      if (result.ok) sentCount++;
    }

    if (status === "delivered") {
      await pool.query(
        `
        UPDATE orders
        SET status = 'delivered',
            delivered_at = NOW()
        WHERE status = 'confirmed'
        AND LOWER(stop) LIKE LOWER($1)
        `,
        [`%${normalizedStop.split(" ")[0]}%`]
      );
    }

    res.json({
      success: true,
      stop: normalizedStop,
      status,
      sentCount,
      totalCustomers: customersAtStop.length,
    });
  } catch (error) {
    console.error("Driver notification error:", error.message);
    res.status(500).json({
      success: false,
      error: "Driver notification failed",
    });
  }
});

app.get("/admin/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM orders
      ORDER BY created_at DESC
      LIMIT 200
      `
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Admin orders error:", error.message);
    res.status(500).json([]);
  }
});

app.post("/admin/confirm-order", requireAdmin, async (req, res) => {
  try {
    const { orderId, index } = req.body;

    let order;

    if (orderId) {
      const result = await pool.query(
        `
        UPDATE orders
        SET status = 'confirmed',
            confirmed_at = NOW()
        WHERE order_id = $1
        RETURNING *
        `,
        [orderId]
      );
      order = result.rows[0];
    } else if (index !== undefined) {
      const list = await pool.query(
        `
        SELECT * FROM orders
        ORDER BY created_at DESC
        LIMIT 200
        `
      );

      const selected = list.rows[index];

      if (selected) {
        const result = await pool.query(
          `
          UPDATE orders
          SET status = 'confirmed',
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

    const confirmationMessage =
      `✅ Your AAHAAR25 order has been confirmed.\n\n` +
      `Day: ${order.day || "Today"}\n` +
      `Stop: ${order.stop}\n\n` +
      `You will receive delivery updates on WhatsApp.`;

    await sendWhatsAppMessage(order.phone, confirmationMessage);

    res.json({ success: true, order });
  } catch (error) {
    console.error("Confirm order error:", error.message);
    res.status(500).json({ success: false });
  }
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log("Database ready");
    });
  })
  .catch((error) => {
    console.error("Database startup error:", error.message);
    process.exit(1);
  });