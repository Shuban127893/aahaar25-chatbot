const express = require("express");

const {
  verifySquareSignature,
  getSquareOrder,
  getSquareConfiguration,
} = require("../services/squareService");

function createSquareRouter({
  pool,
  sendWhatsAppMessage,
}) {
  const router = express.Router();

  router.get("/health", (req, res) => {
    const configuration =
      getSquareConfiguration();

    return res.json({
      success: true,
      square: configuration,
    });
  });

  router.post("/", async (req, res) => {
    console.log(
      "Square webhook route reached"
    );

    try {
      const rawBody = req.body;

      const signature =
        req.headers[
          "x-square-hmacsha256-signature"
        ];

      console.log(
        "Square raw body is Buffer:",
        Buffer.isBuffer(rawBody)
      );

      console.log(
        "Square signature header exists:",
        Boolean(signature)
      );

      const signatureValid =
        verifySquareSignature(
          rawBody,
          signature
        );

      console.log(
        "Square signature valid:",
        signatureValid
      );

      if (!signatureValid) {
        console.warn(
          "Invalid Square webhook signature"
        );

        return res.sendStatus(401);
      }

      let event;

      try {
        event = JSON.parse(
          rawBody.toString("utf8")
        );
      } catch (error) {
        console.error(
          "Could not parse Square webhook body:",
          error.message
        );

        return res.sendStatus(400);
      }

      console.log(
        "Square webhook event type:",
        event.type
      );

      if (
        event.type !==
          "payment.updated" &&
        event.type !==
          "payment.created"
      ) {
        console.log(
          "Ignoring unsupported Square event:",
          event.type
        );

        return res.sendStatus(200);
      }

      const payment =
        event.data?.object?.payment;

      if (!payment) {
        console.warn(
          "Square webhook did not contain payment data"
        );

        return res.sendStatus(200);
      }

      console.log(
        "Square payment webhook details:",
        {
          paymentId:
            payment.id || null,

          squareOrderId:
            payment.order_id || null,

          status:
            payment.status || null,
        }
      );

      if (
        payment.status !==
        "COMPLETED"
      ) {
        console.log(
          "Square payment is not completed:",
          payment.status
        );

        return res.sendStatus(200);
      }

      let orderResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE square_order_id = $1
             OR square_payment_id = $2
          LIMIT 1
          `,
          [
            payment.order_id || null,
            payment.id || null,
          ]
        );

      console.log(
        "Orders found using Square IDs:",
        orderResult.rows.length
      );

      if (
        orderResult.rows.length === 0 &&
        payment.order_id
      ) {
        console.log(
          "Looking up Square order:",
          payment.order_id
        );

        const squareOrder =
          await getSquareOrder(
            payment.order_id
          );

        const referenceId =
          squareOrder?.reference_id;

        console.log(
          "Square order reference ID:",
          referenceId || null
        );

        if (referenceId) {
          orderResult =
            await pool.query(
              `
              SELECT *
              FROM orders
              WHERE order_id = $1
              LIMIT 1
              `,
              [referenceId]
            );

          console.log(
            "Orders found using reference ID:",
            orderResult.rows.length
          );
        }
      }

      if (
        orderResult.rows.length === 0
      ) {
        console.warn(
          "No matching local order found for Square payment",
          {
            paymentId:
              payment.id || null,

            squareOrderId:
              payment.order_id || null,
          }
        );

        return res.sendStatus(200);
      }

      const existingOrder =
        orderResult.rows[0];

      console.log(
        "Matching local order found:",
        {
          orderId:
            existingOrder.order_id,

          currentStatus:
            existingOrder.status,

          phone:
            existingOrder.phone,
        }
      );

      if (
        existingOrder.status ===
          "confirmed" ||
        existingOrder.status ===
          "delivered"
      ) {
        console.log(
          "Order was already confirmed or delivered:",
          existingOrder.order_id
        );

        return res.sendStatus(200);
      }

      const updatedResult =
        await pool.query(
          `
          UPDATE orders
          SET
            status = 'confirmed',
            confirmed_at = NOW(),
            square_payment_id = $1,
            square_receipt_url = $2
          WHERE order_id = $3
            AND status NOT IN (
              'confirmed',
              'delivered'
            )
          RETURNING *
          `,
          [
            payment.id,
            payment.receipt_url || "",
            existingOrder.order_id,
          ]
        );

      if (
        updatedResult.rows.length === 0
      ) {
        console.warn(
          "Order was not updated:",
          existingOrder.order_id
        );

        return res.sendStatus(200);
      }

      const confirmedOrder =
        updatedResult.rows[0];

      console.log(
        "Order updated to confirmed:",
        confirmedOrder.order_id
      );

      if (
        confirmedOrder.phone
      ) {
        const messageResult =
          await sendWhatsAppMessage(
            confirmedOrder.phone,

            `✅ Your AAHAAR25 order has been automatically confirmed.\n\n` +
              `Name: ${confirmedOrder.name}\n` +
              `Day: ${confirmedOrder.day}\n` +
              `Stop: ${confirmedOrder.stop}\n\n` +
              `You will receive delivery updates on WhatsApp.`
          );

        console.log(
          "Automatic confirmation WhatsApp result:",
          {
            success:
              messageResult.ok,

            status:
              messageResult.status ||
              null,
          }
        );
      } else {
        console.warn(
          "Confirmed order has no phone number:",
          confirmedOrder.order_id
        );
      }

      console.log(
        "Order automatically confirmed:",
        confirmedOrder.order_id
      );

      return res.sendStatus(200);
    } catch (error) {
      console.error(
        "Square webhook error:",
        error
      );

      return res.sendStatus(500);
    }
  });

  return router;
}

module.exports =
  createSquareRouter;