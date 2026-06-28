const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

const userSessions = {};

function readJsonFile(fileName, fallback) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(fileName, data) {
  const filePath = path.join(__dirname, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
  console.log("WhatsApp send status:", response.status);
  console.log("WhatsApp response:", data);
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
      body: {
        text:
          "Step 2 of 3:\n" +
          "Choose your Uptown delivery stop.",
      },
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

function normalizeDay(text) {
  const lower = text.toLowerCase();
  if (lower.includes("tuesday") || lower === "tue") return "Tuesday";
  if (lower.includes("wednesday") || lower === "wed") return "Wednesday";
  if (lower.includes("thursday") || lower === "thu") return "Thursday";
  if (lower.includes("friday") || lower === "fri") return "Friday";
  return null;
}

function normalizeStop(text) {
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

app.get("/", (req, res) => {
  res.send("Ahaar25 chatbot backend is running");
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: userMessage,
      max_output_tokens: 300,
    });

    res.json({ reply: response.output_text });
  } catch (error) {
    console.error("Chat error:", error);
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
    console.log("Webhook verified successfully");
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

    console.log("WhatsApp message from:", from);
    console.log("Message:", userText);

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
      const name = userText;
      session.order.name = name;

      const orderLinks = readJsonFile("order-links.json", {});
      const paymentLink = orderLinks?.[session.order.day]?.[session.order.stop];

      const orders = readJsonFile("orders-today.json", []);

      const newOrder = {
        name: session.order.name,
        phone: session.order.phone,
        day: session.order.day,
        stop: session.order.stop,
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      orders.push(newOrder);
      writeJsonFile("orders-today.json", orders);

      delete userSessions[from];

      let reply =
        `Thanks ${name}. Your AAHAAR25 lunch box order request has been saved as pending.\n\n` +
        `Day: ${newOrder.day}\n` +
        `Stop: ${newOrder.stop}\n\n`;

      if (paymentLink) {
        reply +=
          `Please complete payment here:\n${paymentLink}\n\n` +
          `Once payment is confirmed, your order will be added to today's confirmed delivery list.`;
      } else {
        reply += "Payment link was not found for that stop/day. Please call AAHAAR25 for help.";
      }

      await sendWhatsAppMessage(from, reply);
      return res.sendStatus(200);
    }

    if (lower.includes("status")) {
      const orders = readJsonFile("orders-today.json", []);
      const customerOrders = orders.filter((order) => order.phone === from);

      if (customerOrders.length === 0) {
        await sendWhatsAppMessage(
          from,
          "I couldn't find an order connected to this WhatsApp number. To start an order, tap Order Lunch Box below."
        );
        await sendMainMenu(from);
        return res.sendStatus(200);
      }

      const latestOrder = customerOrders[customerOrders.length - 1];

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
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

app.post("/driver/notify-stop", async (req, res) => {
  try {
    const { stop, status } = req.body;

    if (!stop || !status) {
      return res.status(400).json({
        success: false,
        error: "Missing stop or status",
      });
    }

    const normalizedStop = normalizeStop(stop);
    const orders = readJsonFile("orders-today.json", []);

    const customersAtStop = orders.filter(
      (order) =>
        normalizeStop(order.stop) === normalizedStop &&
        order.status === "confirmed"
    );

    if (customersAtStop.length === 0) {
      return res.json({
        success: true,
        sentCount: 0,
        message: `No confirmed customers found for ${stop}`,
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
      if (!customer.phone) continue;
      const result = await sendWhatsAppMessage(customer.phone, whatsappMessage);
      if (result.ok) sentCount++;
    }

    res.json({
      success: true,
      stop: normalizedStop,
      status,
      sentCount,
      totalCustomers: customersAtStop.length,
    });
  } catch (error) {
    console.error("Driver notification error:", error);
    res.status(500).json({
      success: false,
      error: "Driver notification failed",
    });
  }
});

app.get("/admin/orders", (req, res) => {
  try {
    const orders = readJsonFile("orders-today.json", []);
    res.json(orders);
  } catch (error) {
    console.error("Admin orders error:", error);
    res.status(500).json([]);
  }
});

app.post("/admin/confirm-order", async (req, res) => {
  try {
    const { index } = req.body;
    const orders = readJsonFile("orders-today.json", []);

    if (index === undefined || !orders[index]) {
      return res.status(400).json({
        success: false,
        error: "Invalid order index",
      });
    }

    orders[index].status = "confirmed";
    orders[index].confirmedAt = new Date().toISOString();

    writeJsonFile("orders-today.json", orders);

    const order = orders[index];

    const confirmationMessage =
      `✅ Your AAHAAR25 order has been confirmed.\n\n` +
      `Day: ${order.day || "Today"}\n` +
      `Stop: ${order.stop}\n\n` +
      `You will receive delivery updates on WhatsApp.`;

    if (order.phone) {
      await sendWhatsAppMessage(order.phone, confirmationMessage);
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error("Confirm order error:", error);
    res.status(500).json({ success: false });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});