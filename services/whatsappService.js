const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID;

const WHATSAPP_AUTH_TEMPLATE_NAME =
  process.env.WHATSAPP_AUTH_TEMPLATE_NAME ||
  "aahaar25_driver_login";

const WHATSAPP_AUTH_TEMPLATE_LANGUAGE =
  process.env.WHATSAPP_AUTH_TEMPLATE_LANGUAGE ||
  "en_US";

async function sendWhatsAppPayload(payload) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error(
      "WhatsApp environment variables are missing"
    );
  }

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

  let data = {};

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    console.error(
      "WhatsApp send failed:",
      response.status,
      JSON.stringify(data)
    );
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function sendWhatsAppMessage(to, message) {
  return sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body: message,
    },
  });
}

async function sendWhatsAppTemplate(
  to,
  templateName,
  languageCode,
  components = []
) {
  return sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: {
        code: languageCode,
      },
      components,
    },
  });
}

async function sendMainMenu(to) {
  return sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: {
        type: "text",
        text: "AAHAAR25 🍱",
      },
      body: {
        text:
          "👋 Welcome to AAHAAR25!\n\n" +
          "Fresh Uptown Lunch Boxes delivered Tuesday–Friday.\n\n" +
          "What would you like to do?",
      },
      footer: {
        text: "Fresh • Hygienic • Delicious",
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: "START_ORDER",
              title: "🛒 Order",
            },
          },
          {
            type: "reply",
            reply: {
              id: "SHOW_DELIVERY",
              title: "📍 Delivery",
            },
          },
          {
            type: "reply",
            reply: {
              id: "SHOW_PRICE",
              title: "💲 Price",
            },
          },
        ],
      },
    },
  });
}

async function sendDayList(to, days) {
  const dayList =
    Array.isArray(days) && days.length > 0
      ? days
      : [
          { name: "Tuesday", date: null },
          { name: "Wednesday", date: null },
          { name: "Thursday", date: null },
          { name: "Friday", date: null },
        ];

  const firstName = dayList[0].name;
  const lastName =
    dayList[dayList.length - 1].name;

  return sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: "🛒 Lunch Box Order",
      },
      body: {
        text:
          "Great choice! 🍱\n\n" +
          "Step 1 of 4:\n" +
          "Please choose your delivery day.",
      },
      footer: {
        text: `Available ${firstName}–${lastName}`,
      },
      action: {
        button: "Choose Day",
        sections: [
          {
            title: "Delivery Days",
            rows: dayList
              .slice(0, 10)
              .map((day) => ({
                id: `DAY_${day.name}`,
                title: day.date
                  ? `${day.name}, ${day.date}`
                  : day.name,
                description: `Order for ${day.name} delivery`,
              })),
          },
        ],
      },
    },
  });
}

async function sendStopList(to, day, stops) {
  const stopList =
    Array.isArray(stops) && stops.length > 0
      ? stops
      : [];

  return sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: `📍 ${day} Delivery`,
      },
      body: {
        text:
          "Step 2 of 4:\n" +
          "Choose your Uptown delivery stop.",
      },
      footer: {
        text:
          "Driver waits up to 5 minutes at each stop",
      },
      action: {
        button: "Choose Stop",
        sections: [
          {
            title: "Uptown Stops",
            rows: stopList
              .slice(0, 10)
              .map((stop) => ({
                id: `STOP_${stop.location}`,
                title: stop.location.slice(
                  0,
                  24
                ),
                description: stop.time || "",
              })),
          },
        ],
      },
    },
  });
}

async function sendQuantityList(to) {
  return sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: "🍱 Lunch Box Quantity",
      },
      body: {
        text:
          "Step 3 of 4:\n" +
          "How many lunch boxes would you like?",
      },
      action: {
        button: "Choose Quantity",
        sections: [
          {
            title: "Quantity",
            rows: [
              {
                id: "QTY_1",
                title: "1 lunch box",
              },
              {
                id: "QTY_2",
                title: "2 lunch boxes",
              },
              {
                id: "QTY_3",
                title: "3 lunch boxes",
              },
              {
                id: "QTY_4",
                title: "4 lunch boxes",
              },
              {
                id: "QTY_MORE",
                title: "More than 4",
                description:
                  "Type in the exact number",
              },
            ],
          },
        ],
      },
    },
  });
}

async function sendDriverLoginCode(to, code) {
  return sendWhatsAppTemplate(
    to,
    WHATSAPP_AUTH_TEMPLATE_NAME,
    WHATSAPP_AUTH_TEMPLATE_LANGUAGE,
    [
      {
        type: "body",
        parameters: [
          {
            type: "text",
            text: code,
          },
        ],
      },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [
          {
            type: "text",
            text: code,
          },
        ],
      },
    ]
  );
}

async function sendDriverInvite(
  to,
  driverName,
  inviteUrl
) {
  return sendWhatsAppMessage(
    to,
    `AAHAAR25 Driver Access\n\n` +
      `Hi ${driverName}, tap this secure link to access the driver system:\n\n` +
      `${inviteUrl}\n\n` +
      `This invitation expires in 24 hours.`
  );
}

module.exports = {
  sendWhatsAppPayload,
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  sendMainMenu,
  sendDayList,
  sendStopList,
  sendQuantityList,
  sendDriverLoginCode,
  sendDriverInvite,
};