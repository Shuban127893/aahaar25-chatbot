const express = require("express");

const {
  sendWhatsAppMessage,
  sendMainMenu,
  sendDayList,
  sendStopList,
} = require("../services/whatsappService");

function createWhatsAppRouter({
  pool,
  createSquarePaymentLink,
  generateOrderId,
  client,
  CHATBOT_SYSTEM_PROMPT,
}) {
  const router = express.Router();

  const WHATSAPP_VERIFY_TOKEN =
    process.env.WHATSAPP_VERIFY_TOKEN;

  const userSessions = {};

  function normalizeDay(text = "") {
    const lower = text.toLowerCase();

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
    const lower = text.toLowerCase();

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

  function getIncomingText(message) {
    if (message.type === "text") {
      return message.text?.body?.trim() || "";
    }

    if (message.type === "interactive") {
      const buttonReply =
        message.interactive?.button_reply;

      const listReply =
        message.interactive?.list_reply;

      if (buttonReply) {
        return (
          buttonReply.id ||
          buttonReply.title ||
          ""
        );
      }

      if (listReply) {
        return listReply.id || listReply.title || "";
      }
    }

    return "";
  }

  router.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (
      mode === "subscribe" &&
      token === WHATSAPP_VERIFY_TOKEN
    ) {
      console.log(
        "WhatsApp webhook verified successfully"
      );

      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  });

  router.post("/webhook", async (req, res) => {
    try {
      const body = req.body;

      const message =
        body.entry?.[0]?.changes?.[0]?.value
          ?.messages?.[0];

      if (!message) {
        return res.sendStatus(200);
      }

      const from = message.from;
      const userText = getIncomingText(message);
      const lower = userText.toLowerCase();

      console.log(
        "WhatsApp message received:",
        userText
      );

      let session = userSessions[from];

      if (lower === "cancel") {
        delete userSessions[from];

        await sendWhatsAppMessage(
          from,
          "Your order request has been cancelled."
        );

        return res.sendStatus(200);
      }

      if (
        ["hi", "hello", "hey", "menu", "start"].includes(
          lower
        )
      ) {
        await sendMainMenu(from);
        return res.sendStatus(200);
      }

      if (
        userText === "SHOW_PRICE" ||
        lower.includes("price") ||
        lower.includes("cost")
      ) {
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

      if (
        userText === "START_ORDER" ||
        lower.includes("order") ||
        lower.includes("lunch box")
      ) {
        userSessions[from] = {
          step: "ask_day",
          order: {
            phone: from,
            status: "pending",
          },
        };

        await sendDayList(from);

        return res.sendStatus(200);
      }

      session = userSessions[from];

      if (session?.step === "ask_day") {
        let day = null;

        if (userText.startsWith("DAY_")) {
          day = userText.replace("DAY_", "");
        } else {
          day = normalizeDay(userText);
        }

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

        if (userText.startsWith("STOP_")) {
          stop = userText.replace("STOP_", "");
        } else {
          stop = normalizeStop(userText);
        }

        if (!stop) {
          await sendStopList(
            from,
            session.order.day
          );

          return res.sendStatus(200);
        }

        session.order.stop = stop;
        session.step = "ask_name";

        await sendWhatsAppMessage(
          from,
          "Got it. What name should we put on the order?"
        );

        return res.sendStatus(200);
      }

      if (session?.step === "ask_name") {
        const cleanName = userText
          .replace(/[<>]/g, "")
          .trim()
          .slice(0, 80);

        if (!cleanName) {
          await sendWhatsAppMessage(
            from,
            "Please enter a valid name for the order."
          );

          return res.sendStatus(200);
        }

        const newOrder = {
          order_id: generateOrderId(),
          name: cleanName,
          phone: session.order.phone,
          day: session.order.day,
          stop: session.order.stop,
        };

        const squareLink =
          await createSquarePaymentLink(newOrder);

        const inserted = await pool.query(
          `
          INSERT INTO orders (
            order_id,
            name,
            phone,
            day,
            stop,
            status,
            square_payment_link,
            square_payment_link_id,
            square_order_id
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'pending',
            $6,
            $7,
            $8
          )
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
            `Please complete payment here:\n` +
            `${order.square_payment_link}\n\n` +
            `After payment, your order should confirm automatically.`
        );

        return res.sendStatus(200);
      }

      if (lower.includes("status")) {
        const result = await pool.query(
          `
          SELECT *
          FROM orders
          WHERE phone = $1
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [from]
        );

        if (result.rows.length === 0) {
          await sendWhatsAppMessage(
            from,
            "I couldn't find an order connected to this WhatsApp number."
          );

          await sendMainMenu(from);

          return res.sendStatus(200);
        }

        const latestOrder = result.rows[0];

        await sendWhatsAppMessage(
          from,
          `AAHAAR25 Order Status\n\n` +
            `Status: ${latestOrder.status}\n` +
            `Day: ${
              latestOrder.day || "Not selected"
            }\n` +
            `Stop: ${
              latestOrder.stop || "Not selected"
            }`
        );

        return res.sendStatus(200);
      }

      /*
      Nothing matched a keyword or an active
      order step. Ask Claude, using the same
      business-data system prompt as the website
      chatbot, so free-form questions get a real
      answer instead of just the main menu.

      This never touches the ordering flow above,
      since every ordering step already returned
      a response earlier in this function.
      */

      try {
        const aiResponse =
          await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 300,
            system: CHATBOT_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: userText,
              },
            ],
          });

        const aiReply = aiResponse.content
          .filter(
            (block) => block.type === "text"
          )
          .map((block) => block.text)
          .join("\n");

        if (aiReply) {
          await sendWhatsAppMessage(
            from,
            aiReply
          );

          await sendMainMenu(from);

          return res.sendStatus(200);
        }
      } catch (error) {
        console.error(
          "WhatsApp AI fallback error:",
          error
        );
      }

      await sendMainMenu(from);

      return res.sendStatus(200);
    } catch (error) {
      console.error(
        "WhatsApp webhook error:",
        error
      );

      return res.sendStatus(500);
    }
  });

  return router;
}

module.exports = createWhatsAppRouter;