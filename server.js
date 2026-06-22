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

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// --------------------
// Helper: Send WhatsApp Message
// --------------------
async function sendWhatsAppMessage(to, message) {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: {
          body: message,
        },
      }),
    }
  );

  const data = await response.json();
  console.log("WhatsApp send status:", response.status);
  console.log("WhatsApp response:", data);

  return { ok: response.ok, data };
}

// --------------------
// Website Health Check
// --------------------
app.get("/", (req, res) => {
  res.send("Ahaar25 chatbot backend is running");
});

// --------------------
// Website Chatbot Route
// --------------------
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: userMessage,
      max_output_tokens: 300,
    });

    res.json({
      reply: response.output_text,
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({
      reply: "Sorry, something went wrong. Please call AAHAAR25 directly.",
    });
  }
});

// --------------------
// Meta Webhook Verification
// --------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --------------------
// WhatsApp Incoming Messages
// --------------------
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    const message =
      body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const userText = message.text?.body || "";

    console.log("WhatsApp message from:", from);
    console.log("Message:", userText);

    let botReply = "";

    const lower = userText.toLowerCase();

    if (lower.includes("price") || lower.includes("cost")) {
      botReply = "The AAHAAR25 Uptown Lunch Box is $13.99 plus applicable taxes.";
    } else if (lower.includes("time") || lower.includes("delivery") || lower.includes("spot")) {
      botReply =
        "AAHAAR25 Uptown delivery stops are:\n\n" +
        "• Gateway Village — 11:30 AM - 11:45 AM\n" +
        "• Discovery Place — 11:45 AM - 12:00 PM\n" +
        "• Ally Center — 12:00 PM\n" +
        "• One Wells Fargo Center — 12:30 PM\n\n" +
        "Delivery is available Tuesday through Friday.";
    } else if (lower.includes("order")) {
      botReply =
        "I can help with Uptown Lunch Box ordering. Please choose one of the listed Uptown delivery stops: Gateway Village, Discovery Place, Ally Center, or One Wells Fargo Center.";
    } else {
      const aiResponse = await client.responses.create({
        model: "gpt-4o-mini",
        input:
          "You are the AAHAAR25 restaurant chatbot. Answer only about Uptown Lunch Boxes, delivery stops, pricing, cutoff time, and ordering. Do not invent delivery locations.\n\nCustomer: " +
          userText,
        max_output_tokens: 300,
      });

      botReply = aiResponse.output_text;
    }

    await sendWhatsAppMessage(from, botReply);

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// --------------------
// Driver Stop Notification Route
// --------------------
app.post("/driver/notify-stop", async (req, res) => {
  try {
    const { stop, status } = req.body;

    if (!stop || !status) {
      return res.status(400).json({
        success: false,
        error: "Missing stop or status",
      });
    }

    const ordersPath = path.join(__dirname, "orders-today.json");

    if (!fs.existsSync(ordersPath)) {
      return res.status(404).json({
        success: false,
        error: "orders-today.json not found",
      });
    }

    const orders = JSON.parse(fs.readFileSync(ordersPath, "utf8"));

    const customersAtStop = orders.filter(
      (order) => order.stop.toLowerCase() === stop.toLowerCase()
    );

    if (customersAtStop.length === 0) {
      return res.json({
        success: true,
        sentCount: 0,
        message: `No customers found for ${stop}`,
      });
    }

    let whatsappMessage = "";

    if (status === "10min") {
      whatsappMessage = `AAHAAR25 Update: Your lunch box driver is about 10 minutes away from ${stop}.`;
    } else if (status === "5min") {
      whatsappMessage = `AAHAAR25 Update: Your lunch box driver is about 5 minutes away from ${stop}. Please be ready at the delivery spot.`;
    } else if (status === "arrived") {
      whatsappMessage = `AAHAAR25 Update: Your lunch box driver has arrived at ${stop}. Please meet the driver at the delivery spot.`;
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

      if (result.ok) {
        sentCount++;
      }
    }

    res.json({
      success: true,
      stop,
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

// --------------------
// Start Server
// --------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});