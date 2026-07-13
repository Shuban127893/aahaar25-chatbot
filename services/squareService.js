const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_WEBHOOK_SIGNATURE_KEY =
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

const SQUARE_ENVIRONMENT =
  process.env.SQUARE_ENVIRONMENT || "sandbox";

const SQUARE_BASE_URL =
  SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

const SQUARE_WEBHOOK_URL =
  process.env.SQUARE_WEBHOOK_URL ||
  "https://aahaar25-chatbot-production.up.railway.app/square-webhook";

const SQUARE_REDIRECT_URL =
  process.env.SQUARE_REDIRECT_URL ||
  "https://aahaar25-chatbot-production.up.railway.app";

const SQUARE_VERSION =
  process.env.SQUARE_VERSION || "2026-05-20";

/**
 * Checks that the required Square environment variables exist.
 */
function validateSquareConfiguration() {
  const missingVariables = [];

  if (!SQUARE_ACCESS_TOKEN) {
    missingVariables.push("SQUARE_ACCESS_TOKEN");
  }

  if (!SQUARE_LOCATION_ID) {
    missingVariables.push("SQUARE_LOCATION_ID");
  }

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing Square environment variables: ${missingVariables.join(", ")}`
    );
  }
}

/**
 * Sends a request to the Square API.
 */
async function squareRequest(
  endpoint,
  method = "GET",
  body = null
) {
  if (!SQUARE_ACCESS_TOKEN) {
    throw new Error(
      "SQUARE_ACCESS_TOKEN is not configured"
    );
  }

  const response = await fetch(
    `${SQUARE_BASE_URL}${endpoint}`,
    {
      method,
      headers: {
        "Square-Version": SQUARE_VERSION,
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );

  const responseText = await response.text();

  let data = {};

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = {
        rawResponse: responseText,
      };
    }
  }

  if (!response.ok) {
    console.error(
      "Square API error:",
      response.status,
      JSON.stringify(data)
    );

    const squareErrorMessage =
      data.errors?.[0]?.detail ||
      data.errors?.[0]?.code ||
      "Square API request failed";

    const error = new Error(squareErrorMessage);

    error.status = response.status;
    error.squareErrors = data.errors || [];

    throw error;
  }

  return data;
}

/**
 * Creates a Square payment link for an AAHAAR25 order.
 */
async function createSquarePaymentLink(order) {
  validateSquareConfiguration();

  if (
    !order?.order_id ||
    !order?.name ||
    !order?.phone ||
    !order?.day ||
    !order?.stop
  ) {
    throw new Error(
      "Order ID, name, phone, day, and stop are required"
    );
  }

  const requestBody = {
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

      redirect_url: SQUARE_REDIRECT_URL,
    },

    payment_note:
      `AAHAAR25 order ${order.order_id}`,
  };

  const data = await squareRequest(
    "/v2/online-checkout/payment-links",
    "POST",
    requestBody
  );

  const paymentLink = data.payment_link;

  if (!paymentLink?.url) {
    throw new Error(
      "Square did not return a payment link"
    );
  }

  return {
    url: paymentLink.url,

    paymentLinkId:
      paymentLink.id || null,

    squareOrderId:
      paymentLink.order_id || null,
  };
}

/**
 * Verifies that the Square webhook actually came from Square.
 */
function verifySquareSignature(
  rawBody,
  signatureHeader
) {
  if (
    !SQUARE_WEBHOOK_SIGNATURE_KEY ||
    !SQUARE_WEBHOOK_URL ||
    !signatureHeader ||
    !Buffer.isBuffer(rawBody)
  ) {
    return false;
  }

  const hmac = crypto.createHmac(
    "sha256",
    SQUARE_WEBHOOK_SIGNATURE_KEY
  );

  hmac.update(
    SQUARE_WEBHOOK_URL +
      rawBody.toString("utf8")
  );

  const expectedSignature =
    hmac.digest("base64");

  const expectedBuffer =
    Buffer.from(expectedSignature);

  const receivedBuffer =
    Buffer.from(String(signatureHeader));

  if (
    expectedBuffer.length !==
    receivedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    receivedBuffer
  );
}

/**
 * Gets a Square payment using its payment ID.
 */
async function getSquarePayment(paymentId) {
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

/**
 * Gets a Square order using its Square order ID.
 */
async function getSquareOrder(squareOrderId) {
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

/**
 * Refunds a Square payment.
 *
 * If amountMoney is not provided, the service retrieves
 * the original payment amount automatically.
 */
async function refundSquarePayment({
  paymentId,

  amountMoney,

  reason =
    "AAHAAR25 order cancelled by administrator",

  idempotencyKey = crypto.randomUUID(),
}) {
  if (!paymentId) {
    throw new Error(
      "Square payment ID is required"
    );
  }

  let refundAmount = amountMoney;

  if (!refundAmount) {
    const payment =
      await getSquarePayment(paymentId);

    refundAmount =
      payment?.amount_money;
  }

  if (
    !refundAmount ||
    !Number.isInteger(refundAmount.amount) ||
    !refundAmount.currency
  ) {
    throw new Error(
      "A valid Square refund amount was not available"
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
        refundAmount,

      reason,
    }
  );

  if (!data.refund) {
    throw new Error(
      "Square did not return a refund"
    );
  }

  return data.refund;
}

/**
 * Finds the matching AAHAAR25 database order
 * for a completed Square payment.
 */
async function findLocalOrderForPayment(
  pool,
  payment
) {
  let result = await pool.query(
    `
    SELECT *
    FROM orders
    WHERE square_order_id = $1
       OR square_payment_id = $2
    LIMIT 1
    `,
    [
      payment.order_id || null,
      payment.id,
    ]
  );

  if (result.rows.length > 0) {
    return result.rows[0];
  }

  if (!payment.order_id) {
    return null;
  }

  const squareOrder =
    await getSquareOrder(
      payment.order_id
    );

  const referenceId =
    squareOrder?.reference_id;

  if (!referenceId) {
    return null;
  }

  result = await pool.query(
    `
    SELECT *
    FROM orders
    WHERE order_id = $1
    LIMIT 1
    `,
    [referenceId]
  );

  return result.rows[0] || null;
}

/**
 * Handles a Square webhook event.
 */
async function processSquareWebhook({
  rawBody,

  signature,

  pool,

  sendWhatsAppMessage,
}) {
  const isValidSignature =
    verifySquareSignature(
      rawBody,
      signature
    );

  if (!isValidSignature) {
    return {
      statusCode: 401,

      message:
        "Invalid Square webhook signature",
    };
  }

  let event;

  try {
    event = JSON.parse(
      rawBody.toString("utf8")
    );
  } catch {
    return {
      statusCode: 400,

      message:
        "Invalid Square webhook body",
    };
  }

  const supportedEventTypes = [
    "payment.updated",
    "payment.created",
  ];

  if (
    !supportedEventTypes.includes(
      event.type
    )
  ) {
    return {
      statusCode: 200,

      message:
        "Square event ignored",
    };
  }

  const payment =
    event.data?.object?.payment;

  if (
    !payment ||
    payment.status !== "COMPLETED"
  ) {
    return {
      statusCode: 200,

      message:
        "Incomplete Square payment ignored",
    };
  }

  const order =
    await findLocalOrderForPayment(
      pool,
      payment
    );

  if (!order) {
    console.warn(
      "No matching local order found for Square payment:",
      payment.id
    );

    return {
      statusCode: 200,

      message:
        "No matching local order",
    };
  }

  if (order.status === "confirmed") {
    return {
      statusCode: 200,

      message:
        "Order already confirmed",

      order,
    };
  }

  const updatedResult =
    await pool.query(
      `
      UPDATE orders
      SET status = 'confirmed',
          confirmed_at = NOW(),
          square_payment_id = $1,
          square_receipt_url = $2
      WHERE order_id = $3
        AND status <> 'confirmed'
      RETURNING *
      `,
      [
        payment.id,

        payment.receipt_url || "",

        order.order_id,
      ]
    );

  const confirmedOrder =
    updatedResult.rows[0] || order;

  if (
    updatedResult.rows[0] &&
    sendWhatsAppMessage
  ) {
    try {
      await sendWhatsAppMessage(
        confirmedOrder.phone,

        `✅ Your AAHAAR25 order has been automatically confirmed.\n\n` +
          `Name: ${confirmedOrder.name}\n` +
          `Day: ${confirmedOrder.day}\n` +
          `Stop: ${confirmedOrder.stop}\n\n` +
          `You will receive delivery updates on WhatsApp.`
      );
    } catch (error) {
      console.error(
        "Payment confirmed, but WhatsApp confirmation failed:",
        error.message
      );
    }
  }

  console.log(
    "Order automatically confirmed:",
    confirmedOrder.order_id
  );

  return {
    statusCode: 200,

    message:
      "Order confirmed",

    order:
      confirmedOrder,
  };
}

module.exports = {
  createSquarePaymentLink,

  findLocalOrderForPayment,

  getSquareOrder,

  getSquarePayment,

  processSquareWebhook,

  refundSquarePayment,

  squareRequest,

  validateSquareConfiguration,

  verifySquareSignature,
};