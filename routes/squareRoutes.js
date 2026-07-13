const express = require("express");

const {
  processSquareWebhook,
} = require("../services/squareService");

function createSquareRouter({
  pool,
  sendWhatsAppMessage,
}) {
  if (!pool) {
    throw new Error(
      "createSquareRouter requires a database pool"
    );
  }

  const router = express.Router();

  router.post(
    "/square-webhook",
    async (req, res) => {
      try {
        const signature =
          req.headers[
            "x-square-hmacsha256-signature"
          ];

        const result =
          await processSquareWebhook({
            rawBody: req.body,

            signature,

            pool,

            sendWhatsAppMessage,
          });

        if (result.statusCode === 401) {
          console.warn(result.message);
        }

        return res
          .status(result.statusCode)
          .send(result.message);
      } catch (error) {
        console.error(
          "Square webhook error:",
          error.message
        );

        return res
          .status(500)
          .send(
            "Square webhook processing failed"
          );
      }
    }
  );

  return router;
}

module.exports = createSquareRouter;