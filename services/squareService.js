const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN;

const SQUARE_LOCATION_ID =
  process.env.SQUARE_LOCATION_ID;

const SQUARE_WEBHOOK_SIGNATURE_KEY =
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

const SQUARE_ENVIRONMENT =
  process.env.SQUARE_ENVIRONMENT || "sandbox";

const APP_BASE_URL = (
  process.env.APP_BASE_URL ||
  "https://aahaar25-chatbot-production.up.railway.app"
).replace(/\/+$/, "");

const SQUARE_BASE_URL =
  SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

const SQUARE_WEBHOOK_URL =
  `${APP_BASE_URL}/square-webhook`;

async function squareRequest(
  endpoint,
  method = "GET",
  body = null
) {
  if (!SQUARE_ACCESS_TOKEN) {
    throw new Error(
      "SQUARE_ACCESS_TOKEN is missing"
    );
  }

  const response = await fetch(
    `${SQUARE_BASE_URL}${endpoint}`,
    {
      method,
      headers: {
        "Square-Version": "2026-05-20",
        Authorization:
          `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body
        ? JSON.stringify(body)
        : undefined,
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
      "Square API request failed:",
      response.status,
      JSON.stringify(data)
    );

    const error = new Error(
      "Square API request failed"
    );

    error.status = response.status;
    error.squareResponse = data;

    throw error;
  }

  return data;
}

async function createSquarePaymentLink(
  order
) {
  if (!SQUARE_LOCATION_ID) {
    throw new Error(
      "SQUARE_LOCATION_ID is missing"
    );
  }

  if (!order?.order_id) {
    throw new Error(
      "Local order ID is missing"
    );
  }

  const requestBody = {
    idempotency_key: order.order_id,

    description:
      `AAHAAR25 Lunch Box - ${order.name}`,

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
          name:
            `AAHAAR25 Lunch Box - ${order.stop}`,

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
      redirect_url: APP_BASE_URL,
    },

    payment_note:
      `AAHAAR25 order ${order.order_id}`,
  };

  const data = await squareRequest(
    "/v2/online-checkout/payment-links",
    "POST",
    requestBody
  );

  const paymentLink =
    data.payment_link;

  if (!paymentLink?.url) {
    console.error(
      "Square payment link response:",
      JSON.stringify(data)
    );

    throw new Error(
      "Square did not return a payment link"
    );
  }

  console.log(
    "Square payment link created:",
    {
      localOrderId: order.order_id,
      squareOrderId:
        paymentLink.order_id || null,
      paymentLinkId:
        paymentLink.id || null,
    }
  );

  return {
    url: paymentLink.url,

    paymentLinkId:
      paymentLink.id || null,

    squareOrderId:
      paymentLink.order_id || null,
  };
}

function verifySquareSignature(
  rawBody,
  signatureHeader
) {
  if (!SQUARE_WEBHOOK_SIGNATURE_KEY) {
    console.error(
      "SQUARE_WEBHOOK_SIGNATURE_KEY is missing"
    );

    return false;
  }

  if (!signatureHeader) {
    console.error(
      "Square signature header is missing"
    );

    return false;
  }

  if (!Buffer.isBuffer(rawBody)) {
    console.error(
      "Square webhook body is not a Buffer"
    );

    return false;
  }

  const webhookBody =
    rawBody.toString("utf8");

  const signatureSource =
    SQUARE_WEBHOOK_URL +
    webhookBody;

  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        SQUARE_WEBHOOK_SIGNATURE_KEY
      )
      .update(signatureSource)
      .digest("base64");

  const expectedBuffer =
    Buffer.from(expectedSignature);

  const receivedBuffer =
    Buffer.from(
      String(signatureHeader)
    );

  if (
    expectedBuffer.length !==
    receivedBuffer.length
  ) {
    console.error(
      "Square signature lengths do not match"
    );

    return false;
  }

  try {
    return crypto.timingSafeEqual(
      expectedBuffer,
      receivedBuffer
    );
  } catch (error) {
    console.error(
      "Square signature comparison failed:",
      error.message
    );

    return false;
  }
}

async function getSquareOrder(
  squareOrderId
) {
  if (!squareOrderId) {
    throw new Error(
      "Square order ID is required"
    );
  }

  const data = await squareRequest(
    `/v2/orders/${encodeURIComponent(
      squareOrderId
    )}`
  );

  return data.order || null;
}

async function getSquarePayment(
  paymentId
) {
  if (!paymentId) {
    throw new Error(
      "Square payment ID is required"
    );
  }

  const data = await squareRequest(
    `/v2/payments/${encodeURIComponent(
      paymentId
    )}`
  );

  return data.payment || null;
}

async function refundSquarePayment({
  paymentId,
  amountMoney,
  reason =
    "AAHAAR25 order cancelled by administrator",
  idempotencyKey =
    crypto.randomUUID(),
}) {
  if (!paymentId) {
    throw new Error(
      "Square payment ID is required"
    );
  }

  if (
    !amountMoney ||
    !Number.isInteger(
      amountMoney.amount
    ) ||
    !amountMoney.currency
  ) {
    throw new Error(
      "A valid refund amount is required"
    );
  }

  const data = await squareRequest(
    "/v2/refunds",
    "POST",
    {
      idempotency_key:
        idempotencyKey,

      payment_id:
        paymentId,

      amount_money:
        amountMoney,

      reason,
    }
  );

  return data.refund || null;
}

function getSquareConfiguration() {
  return {
    environment:
      SQUARE_ENVIRONMENT,

    baseUrl:
      SQUARE_BASE_URL,

    webhookUrl:
      SQUARE_WEBHOOK_URL,

    hasAccessToken:
      Boolean(
        SQUARE_ACCESS_TOKEN
      ),

    hasLocationId:
      Boolean(
        SQUARE_LOCATION_ID
      ),

    hasSignatureKey:
      Boolean(
        SQUARE_WEBHOOK_SIGNATURE_KEY
      ),
  };
}

module.exports = {
  squareRequest,
  createSquarePaymentLink,
  verifySquareSignature,
  getSquareOrder,
  getSquarePayment,
  refundSquarePayment,
  getSquareConfiguration,
};