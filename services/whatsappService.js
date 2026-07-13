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

async function sendDayList(to) {
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
          "Step 1 of 3:\n" +
          "Please choose your delivery day.",
      },
      footer: {
        text: "Available Tuesday–Friday",
      },
      action: {
        button: "Choose Day",
        sections: [
          {
            title: "Delivery Days",
            rows: [
              {
                id: "DAY_Tuesday",
                title: "Tuesday",
                description:
                  "Order for Tuesday delivery",
              },
              {
                id: "DAY_Wednesday",
                title: "Wednesday",
                description:
                  "Order for Wednesday delivery",
              },
              {
                id: "DAY_Thursday",
                title: "Thursday",
                description:
                  "Order for Thursday delivery",
              },
              {
                id: "DAY_Friday",
                title: "Friday",
                description:
                  "Order for Friday delivery",
              },
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
      header: {
        type: "text",
        text: `📍 ${day} Delivery`,
      },
      body: {
        text:
          "Step 2 of 3:\n" +
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
            rows: [
              {
                id: "STOP_Gateway Village",
                title: "Gateway Village",
                description: "11:30 AM",
              },
              {
                id: "STOP_Discovery Place",
                title: "Discovery Place",
                description: "11:45 AM",
              },
              {
                id: "STOP_Ally Center",
                title: "Ally Center",
                description: "12:00 PM",
              },
              {
                id: "STOP_One Wells Fargo",
                title: "One Wells Fargo",
                description: "12:30 PM",
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
  sendDriverLoginCode,
  sendDriverInvite,
};