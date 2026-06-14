const express = require("express");
const cors = require("cors");
require("dotenv").config();

const fs = require("fs");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const deliveryInfo = JSON.parse(fs.readFileSync("./delivery-info.json", "utf8"));
const menuInfo = JSON.parse(fs.readFileSync("./menu-info.json", "utf8"));
const orderLinks = JSON.parse(fs.readFileSync("./order-links.json", "utf8"));

app.get("/", (req, res) => {
  res.send("Ahaar25 chatbot backend is running");
});

function directAnswer(userMessage) {
  const message = userMessage.toLowerCase();

  const orderStops = {
    "Gateway Village": "11:30 AM - 11:45 AM",
    "Discovery Place": "11:45 AM - 12:00 PM",
    "Ally Center": "12:00 PM",
    "One Wells Fargo": "12:30 PM",
  };

  const days = ["Tuesday", "Wednesday", "Thursday", "Friday"];
  const locations = Object.keys(orderStops);

  const deliveryStopsText =
    `AAHAAR25 Uptown Lunch Box delivery is available only at these stops:\n\n` +
    locations.map((location) => `• ${location} — ${orderStops[location]}`).join("\n") +
    `\n\nAvailable days: Tuesday, Wednesday, Thursday, Friday.\nSame-day order cutoff: ${deliveryInfo.sameDayCutoff}.`;

  const wantsToOrder =
    message.includes("order") ||
    message.includes("buy") ||
    message.includes("checkout") ||
    message.includes("link");

  const asksForOrderInfo =
    message.includes("what time") ||
    message.includes("timing") ||
    message.includes("times") ||
    message.includes("locations") ||
    message.includes("location") ||
    message.includes("address") ||
    message.includes("pickup") ||
    message.includes("stops") ||
    message.includes("where can i order") ||
    message.includes("delivery stops") ||
    message.includes("delivery location");

  const matchedDay = days.find((day) => message.includes(day.toLowerCase()));
  const matchedLocation = locations.find((location) =>
    message.includes(location.toLowerCase())
  );

  if (wantsToOrder || asksForOrderInfo) {
    if (matchedDay && matchedLocation) {
      return `You can order the ${matchedDay} Uptown Lunch Box for ${matchedLocation} here:\n${orderLinks[matchedDay][matchedLocation]}\n\nDetails:\n• Stop: ${matchedLocation}\n• Time: ${orderStops[matchedLocation]}\n• Price: ${deliveryInfo.price}\n• Same-day cutoff: ${deliveryInfo.sameDayCutoff}\n• Please order before ${deliveryInfo.sameDayCutoff} for same-day delivery.`;
    }

    if (matchedDay && !matchedLocation) {
      return (
        `For ${matchedDay}, you can order Uptown Lunch Boxes for these stops:\n\n` +
        locations
          .map(
            (location) =>
              `• ${location} — ${orderStops[location]}\n  Order link: ${orderLinks[matchedDay][location]}`
          )
          .join("\n\n")
      );
    }

    if (!matchedDay && matchedLocation) {
      return (
        `For ${matchedLocation}, Uptown Lunch Box delivery is available on:\n\n` +
        days
          .map(
            (day) =>
              `• ${day} — ${orderStops[matchedLocation]}\n  Order link: ${orderLinks[day][matchedLocation]}`
          )
          .join("\n\n")
      );
    }

    return deliveryStopsText;
  }

  if (
    message.includes("price") ||
    message.includes("cost") ||
    message.includes("how much") ||
    message.includes("lunch box")
  ) {
    return `The Uptown Lunch Box is ${deliveryInfo.price}.`;
  }

  if (
    message.includes("phone") ||
    message.includes("call") ||
    message.includes("number") ||
    message.includes("contact")
  ) {
    return `You can call AAHAAR25 at ${deliveryInfo.phone}.`;
  }

  if (
    message.includes("cutoff") ||
    message.includes("same day") ||
    message.includes("order by") ||
    message.includes("deadline")
  ) {
    return `The same-day order cutoff is ${deliveryInfo.sameDayCutoff}.`;
  }

  if (
    message.includes("nc state") ||
    message.includes("raleigh") ||
    message.includes("durham") ||
    message.includes("chapel hill")
  ) {
    return deliveryInfo.unsupportedLocationResponse;
  }

  if (message.includes("dessert") || message.includes("sweet")) {
    const desserts = menuInfo.categories.dessert || [];
    return "Here are some AAHAAR25 desserts:\n" + desserts.map((item) => `• ${item.name} - ${item.price}`).join("\n");
  }

  if (message.includes("appetizer") || message.includes("starter")) {
    const appetizers = menuInfo.categories.appetizers || [];
    return "Here are some AAHAAR25 appetizers:\n" + appetizers.map((item) => `• ${item.name} - ${item.price}`).join("\n");
  }

  if (message.includes("dosa")) {
    const dosas = menuInfo.categories.dosa || [];
    return "Here are the AAHAAR25 dosa options:\n" + dosas.map((item) => `• ${item.name} - ${item.price}`).join("\n");
  }

  for (const categoryName in menuInfo.categories) {
    const category = menuInfo.categories[categoryName];

    for (const item of category) {
      if (message.includes(item.name.toLowerCase())) {
        if (item.status) {
          return `${item.name} is ${item.price}, but it is currently listed as ${item.status}.`;
        }

        return `${item.name} is ${item.price}.`;
      }
    }
  }

  return null;
}

async function getChatbotReply(userMessage) {
  const simpleReply = directAnswer(userMessage);

  if (simpleReply) {
    return simpleReply;
  }

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    max_output_tokens: 300,
    input: `
You are the official AAHAAR25 customer service assistant.

Use ONLY the AAHAAR25 information below.

Main rules:
- Keep answers friendly, short, and useful.
- Do not make up delivery stops, menu items, prices, times, addresses, availability, policies, business hours, promotions, ingredients, or order links.
- If you do not know the answer, do not guess.
- If the answer is not contained in the AAHAAR25 information provided, politely tell the customer to call 704-234-8400.
- If the user asks about something unrelated to AAHAAR25, politely say you can only help with AAHAAR25 menu, pricing, delivery, and ordering questions.
- Do not give a pickup address unless the customer is specifically told to call AAHAAR25.

Delivery rules:
- If the user asks about a delivery location that is not listed, respond with:
"${deliveryInfo.unsupportedLocationResponse}"

Ordering rules:
- If the customer wants to order an Uptown Lunch Box, ask for both the day and the Uptown stop if either is missing.
- If the day and stop are listed, provide the correct Square checkout link.
- Remind customers to order before ${deliveryInfo.sameDayCutoff} for same-day delivery.

Menu rules:
- If the user asks about a menu item that is not listed, say that it is not listed in the current AAHAAR25 menu information and suggest calling 704-234-8400.
- If a menu item is listed as out of stock, clearly say it is currently out of stock.
- If the customer asks for the whole menu, summarize by category instead of listing every item unless they ask for a specific category.

AAHAAR25 Delivery Information:
${JSON.stringify(deliveryInfo, null, 2)}

AAHAAR25 Menu Information:
${JSON.stringify(menuInfo, null, 2)}

AAHAAR25 Order Links:
${JSON.stringify(orderLinks, null, 2)}

Customer Question:
${userMessage}
`,
  });

  return response.output_text;
}

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    const reply = await getChatbotReply(userMessage);

    res.json({ reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Something went wrong with the chatbot backend.",
    });
  }
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
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

    if (!message || message.type !== "text") {
      return res.sendStatus(200);
    }

    const from = message.from;
    const userMessage = message.text.body;

    console.log("WhatsApp message from:", from);
    console.log("Message:", userMessage);

    const reply = await getChatbotReply(userMessage);

   const whatsappResponse = await fetch(
  `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: from,
      type: "text",
      text: {
        body: reply,
      },
    }),
  }
);

const whatsappData = await whatsappResponse.json();

console.log("WhatsApp send status:", whatsappResponse.status);
console.log(
  "WhatsApp send response:",
  JSON.stringify(whatsappData, null, 2)
);

    res.sendStatus(200);
  } catch (error) {
    console.error("WhatsApp webhook error:", error);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});