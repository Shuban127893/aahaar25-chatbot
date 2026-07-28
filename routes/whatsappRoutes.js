const express = require("express");

const {
  sendWhatsAppMessage,
  sendMainMenu,
  sendDayList,
  sendStopList,
} = require("../services/whatsappService");

const {
  getNextDateForDay,
  formatDateForDisplay,
} = require("../utils/dateHelpers");

function createWhatsAppRouter({
  pool,
  createSquarePaymentLink,
  generateOrderId,
  client,
  buildSystemPrompt,
  getDeliveryInfo,
}) {
  const router = express.Router();

  const WHATSAPP_VERIFY_TOKEN =
    process.env.WHATSAPP_VERIFY_TOKEN;

  /*
  Order-flow session state (which step a
  customer is on, and what they've picked
  so far) is stored in the database, not in
  memory. A plain in-memory object would be
  wiped every time this app redeploys or
  restarts, silently dropping any customer
  who happens to be mid-order at that moment.
  */

  async function getSession(phone) {
    const result = await pool.query(
      `SELECT step, order_data
       FROM whatsapp_sessions
       WHERE phone = $1`,
      [phone]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      step: result.rows[0].step,
      order: result.rows[0].order_data || {},
    };
  }

  async function setSession(
    phone,
    step,
    order
  ) {
    await pool.query(
      `INSERT INTO whatsapp_sessions (phone, step, order_data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (phone)
       DO UPDATE SET
         step = $2,
         order_data = $3,
         updated_at = NOW()`,
      [phone, step, JSON.stringify(order)]
    );
  }

  async function clearSession(phone) {
    await pool.query(
      `DELETE FROM whatsapp_sessions WHERE phone = $1`,
      [phone]
    );
  }

  const CANONICAL_DAY_ORDER = [
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
    "Monday",
  ];

  function withDates(dayNames) {
    return dayNames.map((name) => ({
      name,
      date: formatDateForDisplay(
        getNextDateForDay(name)
      ),
    }));
  }

  function getDaysWithStops() {
    const stops =
      getDeliveryInfo()?.deliveryStops || [];

    const uniqueDays = [
      ...new Set(
        stops
          .map((stop) => stop.day)
          .filter(Boolean)
      ),
    ];

    uniqueDays.sort(
      (a, b) =>
        CANONICAL_DAY_ORDER.indexOf(a) -
        CANONICAL_DAY_ORDER.indexOf(b)
    );

    return uniqueDays;
  }

  function getStopsForDay(day) {
    const stops =
      getDeliveryInfo()?.deliveryStops || [];

    return stops.filter(
      (stop) => stop.day === day
    );
  }

  function normalizeDay(text = "") {
    const lower = text.toLowerCase();
    const days = getDaysWithStops();

    return (
      days.find((day) =>
        lower.includes(day.toLowerCase())
      ) || null
    );
  }

  function normalizeStop(text = "", day) {
    const lower = text.toLowerCase();
    const stops = getStopsForDay(day);

    const exact = stops.find((stop) =>
      lower.includes(
        stop.location.toLowerCase()
      )
    );

    if (exact) {
      return String(exact.location).trim();
    }

    // Fall back to a loose word-overlap match,
    // so "gateway" still matches "Gateway Village".
    const loose = stops.find((stop) => {
      const words = stop.location
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 3);

      return words.some((word) =>
        lower.includes(word)
      );
    });

    return loose
      ? String(loose.location).trim()
      : null;
  }

  /*
  Generates a natural-sounding reply via
  Claude instead of a fixed template string.

  facts must contain every real detail the
  reply should mention - Claude is told to
  use ONLY what's given here, so it can
  phrase things naturally without ever
  inventing an order status, date, price,
  or any other detail we haven't verified
  ourselves.

  Always has a plain-text fallback, so a
  customer never gets silence if the AI
  call fails for any reason.
  */
  async function craftReply(
    userMessage,
    facts,
    fallback
  ) {
    try {
      const response =
        await client.messages.create({
          model:
            "claude-haiku-4-5-20251001",
          max_tokens: 200,

          system:
            buildSystemPrompt() +
            `\n\nFor this reply, use ONLY the following verified facts - do not add, guess, or invent anything beyond them:\n\n${facts}\n\n` +
            `Write a short, warm, natural WhatsApp message. No markdown formatting, no headers.`,

          messages: [
            {
              role: "user",
              content:
                userMessage ||
                "(no specific message)",
            },
          ],
        });

      const text = response.content
        .filter(
          (block) => block.type === "text"
        )
        .map((block) => block.text)
        .join("\n")
        .trim();

      return text || fallback;
    } catch (error) {
      console.error(
        "craftReply error:",
        error.message
      );

      return fallback;
    }
  }

  function isQuestion(text = "") {
    const lower = text
      .toLowerCase()
      .trim();

    if (lower.includes("?")) {
      return true;
    }

    return /^(what|whats|how|when|where|why|does|do|is|are|can|could|will)\b/.test(
      lower
    );
  }

  /*
  Matches a keyword as a whole word, not a
  raw substring. Plain .includes() would let
  "hi" match inside "which", "time" match
  inside "sometime", or "order" match inside
  "disorder" - this avoids both kinds of
  false positive.
  */
  function hasWord(text, word) {
    const escaped = word.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

    return new RegExp(
      `\\b${escaped}\\b`,
      "i"
    ).test(text);
  }

  function hasAnyWord(text, words) {
    return words.some((word) =>
      hasWord(text, word)
    );
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

      let session = await getSession(from);

      if (hasWord(lower, "cancel")) {
        if (session) {
          await clearSession(from);

          const reply = await craftReply(
            userText,
            `The customer's in-progress (not yet paid) order request has just been successfully cancelled/dropped.`,
            "Your in-progress order request has been cancelled."
          );

          await sendWhatsAppMessage(
            from,
            reply
          );

          return res.sendStatus(200);
        }

        /*
        No in-progress order to drop. Check
        for a real, already-placed order so
        we never falsely tell a customer
        their paid order was cancelled when
        it wasn't - actually cancelling a
        paid order requires a Square refund,
        which only the restaurant can do.
        */

        const recentOrder = await pool.query(
          `
          SELECT *
          FROM orders
          WHERE phone = $1
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [from]
        );

        const latest = recentOrder.rows[0];

        const cancellableStatuses = [
          "pending",
          "confirmed",
        ];

        if (
          latest &&
          cancellableStatuses.includes(
            latest.status
          )
        ) {
          const phone =
            getDeliveryInfo()?.phone ||
            "the restaurant";

          const statusText =
            latest.status === "confirmed"
              ? "confirmed and paid"
              : "placed, but payment hasn't gone through yet";

          const reply = await craftReply(
            userText,
            `The customer has no order currently in progress (nothing to drop). ` +
              `However, they DO have a real, already-placed order: Day ${latest.day}, Stop ${latest.stop}, status: ${statusText}. ` +
              `Cancelling or refunding an order that's already been placed requires calling the restaurant directly at ${phone} - this cannot be done automatically. ` +
              `Tell the customer this clearly, without saying their order was cancelled (it was not).`,
            `Your order (Day: ${latest.day}, Stop: ${latest.stop}) is ${statusText}.\n\n` +
              `Since it's already been placed, please call us at ${phone} to cancel it or request a refund.`
          );

          await sendWhatsAppMessage(
            from,
            reply
          );

          return res.sendStatus(200);
        }

        const reply = await craftReply(
          userText,
          `The customer has no order in progress right now, and no recent placed order either. There is nothing to cancel.`,
          "You don't have an order in progress right now."
        );

        await sendWhatsAppMessage(
          from,
          reply
        );

        return res.sendStatus(200);
      }

      if (
        hasAnyWord(lower, [
          "hi",
          "hello",
          "hey",
          "menu",
          "start",
        ])
      ) {
        await sendMainMenu(from);
        return res.sendStatus(200);
      }

      if (
        userText === "SHOW_PRICE" ||
        hasAnyWord(lower, [
          "price",
          "cost",
        ])
      ) {
        const reply = await craftReply(
          userText === "SHOW_PRICE"
            ? "What's the price of the Uptown Lunch Box?"
            : userText,
          `Answer using the real, current menu prices already provided to you above. Do not use any price you're not certain is currently accurate.`,
          "Please check our menu for current pricing, or call us directly."
        );

        await sendWhatsAppMessage(
          from,
          reply
        );

        await sendMainMenu(from);

        return res.sendStatus(200);
      }

      if (
        userText === "SHOW_DELIVERY" ||
        hasAnyWord(lower, [
          "time",
          "delivery",
          "spot",
          "location",
        ])
      ) {
        const stops =
          getDeliveryInfo()?.deliveryStops ||
          [];

        const days = getDaysWithStops();

        const stopLines = days
          .map((day) => {
            const dayStops = stops.filter(
              (s) => s.day === day
            );

            if (dayStops.length === 0) {
              return "";
            }

            return (
              `${day}, ${formatDateForDisplay(getNextDateForDay(day))}:\n` +
              dayStops
                .map(
                  (s) =>
                    `${s.location} at ${s.time}`
                )
                .join("\n")
            );
          })
          .filter(Boolean)
          .join("\n\n");

        const reply = stopLines
          ? await craftReply(
              userText === "SHOW_DELIVERY"
                ? "What are your delivery stops and times?"
                : userText,
              `These are the exact, verified delivery stops, days, and dates - use these dates and times exactly as given, do not recalculate or guess any date:\n\n${stopLines}`,
              `AAHAAR25 Uptown delivery stops:\n\n${stopLines}`
            )
          : "Delivery stop information isn't available right now. Please call us for details.";

        await sendWhatsAppMessage(
          from,
          reply
        );

        await sendMainMenu(from);

        return res.sendStatus(200);
      }

      if (
        userText === "START_ORDER" ||
        (!isQuestion(userText) &&
          (hasWord(lower, "order") ||
            lower.includes("lunch box")))
      ) {
        await setSession(from, "ask_day", {
          phone: from,
          status: "pending",
        });

        await sendDayList(
          from,
          withDates(getDaysWithStops())
        );

        return res.sendStatus(200);
      }

      if (session?.step === "ask_day") {
        let day = null;

        if (userText.startsWith("DAY_")) {
          day = userText.replace("DAY_", "");
        } else {
          day = normalizeDay(userText);
        }

        if (
          !day ||
          !getDaysWithStops().includes(day)
        ) {
          await sendDayList(
            from,
            withDates(getDaysWithStops())
          );

          return res.sendStatus(200);
        }

        await setSession(from, "ask_stop", {
          ...session.order,
          day,
        });

        await sendStopList(
          from,
          day,
          getStopsForDay(day)
        );

        return res.sendStatus(200);
      }

      if (session?.step === "ask_stop") {
        let stop = null;

        if (userText.startsWith("STOP_")) {
          stop = userText.replace("STOP_", "");
        } else {
          stop = normalizeStop(
            userText,
            session.order.day
          );
        }

        const validStop = getStopsForDay(
          session.order.day
        ).some(
          (s) => s.location === stop
        );

        if (!stop || !validStop) {
          await sendStopList(
            from,
            session.order.day,
            getStopsForDay(session.order.day)
          );

          return res.sendStatus(200);
        }

        await setSession(from, "ask_name", {
          ...session.order,
          stop,
        });

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

          delivery_date:
            getNextDateForDay(
              session.order.day
            ),
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
            delivery_date,
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
            $6,
            'pending',
            $7,
            $8,
            $9
          )
          RETURNING *
          `,
          [
            newOrder.order_id,
            newOrder.name,
            newOrder.phone,
            newOrder.day,
            newOrder.stop,
            newOrder.delivery_date,
            squareLink.url,
            squareLink.paymentLinkId,
            squareLink.squareOrderId,
          ]
        );

        const order = inserted.rows[0];

        await clearSession(from);

        const lunchBoxIncludes =
          getDeliveryInfo()
            ?.lunchBoxIncludes;

        const includesText =
          Array.isArray(
            lunchBoxIncludes
          ) &&
          lunchBoxIncludes.length > 0
            ? `\n\nYour lunch box includes:\n` +
              lunchBoxIncludes
                .map(
                  (item) => `• ${item}`
                )
                .join("\n")
            : "";

        await sendWhatsAppMessage(
          from,
          `Thanks ${order.name}. Your AAHAAR25 lunch box order request has been saved as pending.\n\n` +
            `Day: ${order.day}, ${formatDateForDisplay(order.delivery_date)}\n` +
            `Stop: ${order.stop}` +
            includesText +
            `\n\nPlease complete payment here:\n` +
            `${order.square_payment_link}\n\n` +
            `After payment, your order should confirm automatically.`
        );

        return res.sendStatus(200);
      }

      if (hasWord(lower, "status")) {
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
          const reply = await craftReply(
            userText,
            `This customer has no order on file connected to their WhatsApp number.`,
            "I couldn't find an order connected to this WhatsApp number."
          );

          await sendWhatsAppMessage(
            from,
            reply
          );

          await sendMainMenu(from);

          return res.sendStatus(200);
        }

        const latestOrder = result.rows[0];

        const dayFacts = latestOrder.day
          ? `${latestOrder.day}, ${formatDateForDisplay(latestOrder.delivery_date)}`
          : "not selected yet";

        const reply = await craftReply(
          userText,
          `The customer's most recent order: status is "${latestOrder.status}", ` +
            `day/date is ${dayFacts}, stop is ${latestOrder.stop || "not selected yet"}. ` +
            `Report these exact facts clearly.`,
          `AAHAAR25 Order Status\n\n` +
            `Status: ${latestOrder.status}\n` +
            `Day: ${
              latestOrder.day
                ? `${latestOrder.day}, ${formatDateForDisplay(latestOrder.delivery_date)}`
                : "Not selected"
            }\n` +
            `Stop: ${
              latestOrder.stop || "Not selected"
            }`
        );

        await sendWhatsAppMessage(
          from,
          reply
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
            system: buildSystemPrompt(),
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