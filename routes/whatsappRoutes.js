const express = require("express");
const rateLimit = require("express-rate-limit");

const {
  sendWhatsAppMessage,
  sendMainMenu,
  sendDayList,
  sendStopList,
  sendQuantityList,
  sendCancelConfirmation,
} = require("../services/whatsappService");

const {
  getNextDateForDay,
  isOrderableThisWeek,
  formatDateForDisplay,
} = require("../utils/dateHelpers");

function createWhatsAppRouter({
  pool,
  createSquarePaymentLink,
  generateOrderId,
  client,
  buildSystemPrompt,
  getDeliveryInfo,
  getLunchBoxPriceCents,
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

  const NUMBER_WORDS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };

  /*
  Standard edit-distance calculation, used
  to catch small misspellings like "fiev" or
  "sevn" without guessing wrong on something
  that affects how much someone gets charged.
  */
  function levenshteinDistance(a, b) {
    const matrix = Array.from(
      { length: a.length + 1 },
      (_, i) => [i]
    );

    for (let j = 0; j <= b.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        matrix[i][j] =
          a[i - 1] === b[j - 1]
            ? matrix[i - 1][j - 1]
            : 1 +
              Math.min(
                matrix[i - 1][j - 1],
                matrix[i - 1][j],
                matrix[i][j - 1]
              );
      }
    }

    return matrix[a.length][b.length];
  }

  /*
  Only auto-corrects a misspelling when
  exactly ONE number word is a close, obvious
  match - e.g. "fiev" only being close to
  "five". If two different number words are
  both plausible, this refuses to guess and
  returns null instead, since a wrong guess
  here means charging someone for the wrong
  quantity.
  */
  function fuzzyMatchNumberWord(text) {
    const candidates = Object.keys(
      NUMBER_WORDS
    ).filter((word) => {
      const maxDistance =
        word.length <= 4 ? 1 : 2;

      return (
        levenshteinDistance(text, word) <=
        maxDistance
      );
    });

    return candidates.length === 1
      ? NUMBER_WORDS[candidates[0]]
      : null;
  }

  function parseQuantityText(text) {
    const cleaned = String(text)
      .trim()
      .toLowerCase();

    if (NUMBER_WORDS[cleaned] !== undefined) {
      return NUMBER_WORDS[cleaned];
    }

    const digitParse = Number.parseInt(
      cleaned,
      10
    );

    if (Number.isInteger(digitParse)) {
      return digitParse;
    }

    const fuzzyMatch =
      fuzzyMatchNumberWord(cleaned);

    return fuzzyMatch !== null
      ? fuzzyMatch
      : NaN;
  }

  function withDates(dayNames, weeksAhead = 0) {
    return dayNames.map((name) => ({
      name,
      date: formatDateForDisplay(
        getNextDateForDay(name, weeksAhead)
      ),
    }));
  }

  function getThisWeekOrderableDays() {
    const cutoffTime =
      getDeliveryInfo()?.sameDayCutoff;

    return getDaysWithStops().filter((day) =>
      isOrderableThisWeek(day, cutoffTime)
    );
  }

  async function sendDayPicker(
    from,
    weeksAhead
  ) {
    if (weeksAhead === 1) {
      const thisWeekDaysStillAvailable =
        getThisWeekOrderableDays().length > 0;

      await sendDayList(
        from,
        withDates(getDaysWithStops(), 1),
        {
          weekLabel: "next week",
          showThisWeekOption:
            thisWeekDaysStillAvailable,
        }
      );

      return;
    }

    const thisWeekDays =
      getThisWeekOrderableDays();

    if (thisWeekDays.length === 0) {
      await sendWhatsAppMessage(
        from,
        "No more delivery days available this week - here's next week's schedule instead:"
      );

      await sendDayList(
        from,
        withDates(getDaysWithStops(), 1),
        { weekLabel: "next week" }
      );

      return;
    }

    await sendDayList(
      from,
      withDates(thisWeekDays, 0),
      { showNextWeekOption: true }
    );
  }

  /*
  Resends whatever prompt matches a given
  order-flow step - used when a customer
  declines cancelling an in-progress order,
  so they land back exactly where they were
  instead of being silently dropped.
  */
  async function resendPromptForStep(
    from,
    step,
    order
  ) {
    if (step === "ask_day") {
      await sendDayPicker(
        from,
        order?.weeksAhead || 0
      );

      return;
    }

    if (step === "ask_stop" && order?.day) {
      await sendStopList(
        from,
        order.day,
        getStopsForDay(order.day)
      );

      return;
    }

    if (step === "ask_quantity") {
      await sendQuantityList(from);

      return;
    }

    if (step === "ask_name") {
      await sendWhatsAppMessage(
        from,
        "What name should we put on the order?"
      );

      return;
    }

    await sendMainMenu(from);
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
    fallback,
    maxTokens = 300
  ) {
    try {
      const response =
        await client.messages.create({
          model:
            "claude-haiku-4-5-20251001",
          max_tokens: maxTokens,

          system:
            buildSystemPrompt() +
            `\n\nFor this reply, use ONLY the following verified facts - do not add, guess, or invent anything beyond them:\n\n${facts}\n\n` +
            `Write a short, warm, natural WhatsApp message. No markdown formatting, no headers. Cover every fact given above completely - never cut off partway through a list.`,

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

      const wasCutOff =
        response.stop_reason === "max_tokens";

      if (wasCutOff) {
        console.error(
          "craftReply was cut off by max_tokens - falling back to the deterministic version instead of sending a truncated reply."
        );

        return fallback;
      }

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

  /*
  WhatsApp/Meta expects a fast HTTP 200
  acknowledging receipt of a webhook event.
  If it doesn't get one quickly enough, it
  assumes delivery failed and automatically
  retries - sometimes minutes later - sending
  the exact same event again.

  Because real processing here can be slow
  (AI-generated replies, database lookups,
  Square calls), this responds to Meta
  IMMEDIATELY and does the actual work
  afterward, in the background. Without this
  split, a slow reply could trigger Meta to
  redeliver the same customer message,
  causing them to receive the same reply
  multiple times without ever texting again.
  */
  /*
  This endpoint receives EVERY customer's
  messages combined, all arriving from Meta's
  own servers rather than individual customer
  IPs - so it needs a limit sized for real
  combined traffic across a busy period (many
  people ordering at once), not general
  per-client API abuse protection. Still a
  real ceiling against outright abuse, just
  set high enough that legitimate traffic
  during a rush can never be silently dropped.
  */
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post("/webhook", webhookLimiter, (req, res) => {
    res.sendStatus(200);

    processIncomingWhatsAppMessage(
      req.body
    ).catch((error) => {
      console.error(
        "WhatsApp webhook error:",
        error
      );
    });
  });

  async function processIncomingWhatsAppMessage(
    body
  ) {
    try {
      const message =
        body.entry?.[0]?.changes?.[0]?.value
          ?.messages?.[0];

      if (!message) {
        return;
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
          await setSession(from, "confirm_cancel", {
            cancelIntent: "session",
            previousStep: session.step,
            previousOrder: session.order,
          });

          await sendCancelConfirmation(
            from,
            "Are you sure you want to cancel your in-progress order request?"
          );

          return;
        }

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

        if (latest && latest.status === "pending") {
          await setSession(from, "confirm_cancel", {
            cancelIntent: "pending",
            orderId: latest.order_id,
            day: latest.day,
            stop: latest.stop,
          });

          await sendCancelConfirmation(
            from,
            `Are you sure you want to cancel your order (Day: ${latest.day}, Stop: ${latest.stop})?`
          );

          return;
        }

        /*
        Paid orders are never cancelled
        automatically - cancelling a paid
        order means issuing a real refund,
        which the restaurant handles directly
        rather than through an automated
        WhatsApp flow.
        */

        if (latest && latest.status === "confirmed") {
          const phone =
            getDeliveryInfo()?.phone ||
            "the restaurant";

          const reply = await craftReply(
            userText,
            `The customer has no order currently in progress (nothing to drop). ` +
              `However, they DO have a real, already-placed order: Day ${latest.day}, Stop ${latest.stop}, status: confirmed and paid. ` +
              `Cancelling a paid order requires a refund, which only the restaurant can issue by calling ${phone} - this cannot be done automatically. ` +
              `Tell the customer this clearly, without saying their order was cancelled (it was not).`,
            `Your order (Day: ${latest.day}, Stop: ${latest.stop}) is confirmed and paid.\n\n` +
              `Since it's already been paid for, please call us at ${phone} to cancel it and request a refund.`
          );

          await sendWhatsAppMessage(
            from,
            reply
          );

          return;
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

        return;
      }

      if (session?.step === "confirm_cancel") {
        const confirmed =
          userText === "CONFIRM_CANCEL_YES" ||
          hasWord(lower, "yes") ||
          hasWord(lower, "yeah") ||
          hasWord(lower, "yep");

        const declined =
          userText === "CONFIRM_CANCEL_NO" ||
          hasWord(lower, "no") ||
          hasWord(lower, "nope");

        if (!confirmed && !declined) {
          await sendCancelConfirmation(
            from,
            "Sorry, I didn't catch that - please tap a button below."
          );

          return;
        }

        if (
          declined &&
          session.order.cancelIntent === "session"
        ) {
          await setSession(
            from,
            session.order.previousStep,
            session.order.previousOrder
          );

          await sendWhatsAppMessage(
            from,
            "No problem, your order is still in progress."
          );

          await resendPromptForStep(
            from,
            session.order.previousStep,
            session.order.previousOrder
          );

          return;
        }

        if (declined) {
          await clearSession(from);

          await sendWhatsAppMessage(
            from,
            "No problem, your order is unchanged."
          );

          return;
        }

        /*
        Confirmed - actually perform the
        cancellation the customer agreed to.
        */

        if (
          session.order.cancelIntent === "session"
        ) {
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

          return;
        }

        if (
          session.order.cancelIntent === "pending"
        ) {
          await pool.query(
            `
            UPDATE orders
            SET status = 'cancelled'
            WHERE order_id = $1
            `,
            [session.order.orderId]
          );

          await clearSession(from);

          const reply = await craftReply(
            userText,
            `The customer's pending (unpaid) order for Day ${session.order.day}, Stop ${session.order.stop} has just been successfully cancelled. It was never paid for, so no refund is needed.`,
            `Your order (Day: ${session.order.day}, Stop: ${session.order.stop}) has been cancelled.`
          );

          await sendWhatsAppMessage(
            from,
            reply
          );

          return;
        }

        await clearSession(from);

        return;
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
        return;
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

        return;
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
              `AAHAAR25 Uptown delivery stops:\n\n${stopLines}`,
              800
            )
          : "Delivery stop information isn't available right now. Please call us for details.";

        await sendWhatsAppMessage(
          from,
          reply
        );

        await sendMainMenu(from);

        return;
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

        await sendDayPicker(from, 0);

        return;
      }

      if (session?.step === "ask_day") {
        const weeksAhead =
          session.order.weeksAhead || 0;

        if (
          userText === "NEXT_WEEK" &&
          weeksAhead === 0
        ) {
          await setSession(from, "ask_day", {
            ...session.order,
            weeksAhead: 1,
          });

          await sendDayPicker(from, 1);

          return;
        }

        if (
          userText === "THIS_WEEK" &&
          weeksAhead === 1
        ) {
          await setSession(from, "ask_day", {
            ...session.order,
            weeksAhead: 0,
          });

          await sendDayPicker(from, 0);

          return;
        }

        let day = null;

        if (userText.startsWith("DAY_")) {
          day = userText.replace("DAY_", "");
        } else {
          day = normalizeDay(userText);
        }

        const validDaysForThisSelection =
          weeksAhead === 1
            ? getDaysWithStops()
            : getThisWeekOrderableDays();

        if (
          !day ||
          !validDaysForThisSelection.includes(
            day
          )
        ) {
          await sendDayPicker(from, weeksAhead);

          return;
        }

        await setSession(from, "ask_stop", {
          ...session.order,
          day,
          weeksAhead,
        });

        await sendStopList(
          from,
          day,
          getStopsForDay(day)
        );

        return;
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

          return;
        }

        await setSession(from, "ask_quantity", {
          ...session.order,
          stop,
        });

        await sendQuantityList(from);

        return;
      }

      if (session?.step === "ask_quantity") {
        let quantity = null;

        if (userText.startsWith("QTY_")) {
          const qtyId = userText.replace(
            "QTY_",
            ""
          );

          if (qtyId === "MORE") {
            await sendWhatsAppMessage(
              from,
              "No problem - just type in the exact number of lunch boxes you'd like (up to 20)."
            );

            return;
          }

          quantity = Number.parseInt(
            qtyId,
            10
          );
        } else {
          quantity = parseQuantityText(
            userText
          );
        }

        const validQuantity =
          Number.isInteger(quantity) &&
          quantity >= 1 &&
          quantity <= 20;

        if (!validQuantity) {
          await sendWhatsAppMessage(
            from,
            "Please reply with a number (like 5) or a written number (like \"five\") for how many lunch boxes you'd like (1-20)."
          );

          await sendQuantityList(from);

          return;
        }

        const unitPriceCents =
          getLunchBoxPriceCents();

        const totalPriceCents =
          unitPriceCents * quantity;

        await setSession(from, "ask_name", {
          ...session.order,
          quantity,
        });

        const totalDisplay = (
          totalPriceCents / 100
        ).toFixed(2);

        const unitDisplay = (
          unitPriceCents / 100
        ).toFixed(2);

        await sendWhatsAppMessage(
          from,
          `${quantity} lunch box${quantity > 1 ? "es" : ""} at $${unitDisplay} each = $${totalDisplay}, plus applicable taxes.\n\n` +
            `Step 4 of 4:\nWhat name should we put on the order?`
        );

        return;
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

          return;
        }

        const unitPriceCents =
          getLunchBoxPriceCents();

        const quantity =
          Number.isInteger(
            session.order.quantity
          ) && session.order.quantity > 0
            ? session.order.quantity
            : 1;

        const totalPriceCents =
          unitPriceCents * quantity;

        const newOrder = {
          order_id: generateOrderId(),
          name: cleanName,
          phone: session.order.phone,
          day: session.order.day,
          stop: session.order.stop,
          quantity,
          unit_price_cents: unitPriceCents,

          delivery_date:
            getNextDateForDay(
              session.order.day,
              session.order.weeksAhead || 0
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
            quantity,
            total_price_cents,
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
            $7,
            $8,
            'pending',
            $9,
            $10,
            $11
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
            newOrder.quantity,
            totalPriceCents,
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
            `Stop: ${order.stop}\n` +
            `Quantity: ${order.quantity}\n` +
            `Total: $${(order.total_price_cents / 100).toFixed(2)}` +
            includesText +
            `\n\nPlease complete payment here:\n` +
            `${order.square_payment_link}\n\n` +
            `After payment, your order should confirm automatically.`
        );

        return;
      }

      if (
        hasAnyWord(lower, [
          "policy",
          "refund",
        ])
      ) {
        const policyText =
          getDeliveryInfo()
            ?.cancellationPolicy;

        const reply = await craftReply(
          userText,
          policyText
            ? `Here is the exact, verified cancellation and refund policy - convey this accurately: "${policyText}"`
            : `A specific written policy isn't set up yet. Tell the customer to call ${getDeliveryInfo()?.phone || "the restaurant"} with any cancellation or refund questions.`,
          policyText ||
            `Please call us at ${getDeliveryInfo()?.phone || "the restaurant"} with any cancellation or refund questions.`
        );

        await sendWhatsAppMessage(
          from,
          reply
        );

        await sendMainMenu(from);

        return;
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

          return;
        }

        const latestOrder = result.rows[0];

        const dayFacts = latestOrder.day
          ? `${latestOrder.day}, ${formatDateForDisplay(latestOrder.delivery_date)}`
          : "not selected yet";

        const reply = await craftReply(
          userText,
          `The customer's most recent order: status is "${latestOrder.status}", ` +
            `day/date is ${dayFacts}, stop is ${latestOrder.stop || "not selected yet"}, ` +
            `quantity is ${latestOrder.quantity || 1}, ` +
            `total price is $${((latestOrder.total_price_cents || 1399) / 100).toFixed(2)}. ` +
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
            }\n` +
            `Quantity: ${
              latestOrder.quantity || 1
            }\n` +
            `Total: $${((latestOrder.total_price_cents || 1399) / 100).toFixed(2)}`
        );

        await sendWhatsAppMessage(
          from,
          reply
        );

        return;
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

          return;
        }
      } catch (error) {
        console.error(
          "WhatsApp AI fallback error:",
          error
        );
      }

      await sendMainMenu(from);

      return;
    } catch (error) {
      console.error(
        "WhatsApp webhook error:",
        error
      );
    }
  }

  return router;
}

module.exports = createWhatsAppRouter;