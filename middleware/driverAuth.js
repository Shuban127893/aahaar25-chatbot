function createDriverAuth({
  pool,
  getCookie,
  driverApiKey,
}) {
  async function requireDriver(
    req,
    res,
    next
  ) {
    try {
      if (
        driverApiKey &&
        req.headers["x-driver-key"] ===
          driverApiKey
      ) {
        req.usedDriverApiKey = true;

        return next();
      }

      const authorization =
        req.headers.authorization || "";

      const bearerToken =
        authorization.startsWith(
          "Bearer "
        )
          ? authorization.slice(7)
          : "";

      const cookieToken = getCookie(
        req,
        "driver_session"
      );

      const token =
        bearerToken || cookieToken;

      if (!token) {
        return res.status(401).json({
          success: false,
          error:
            "Driver login required",
        });
      }

      const result = await pool.query(
        `
        SELECT drivers.*
        FROM driver_sessions
        JOIN drivers
          ON drivers.id =
             driver_sessions.driver_id
        WHERE driver_sessions.token = $1
          AND driver_sessions.expires_at > NOW()
          AND drivers.is_active = TRUE
        LIMIT 1
        `,
        [token]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error:
            "Invalid or expired driver session",
        });
      }

      req.driver = result.rows[0];
      req.driverSessionToken = token;

      return next();
    } catch (error) {
      console.error(
        "Driver authentication error:",
        error.message
      );

      return res.status(401).json({
        success: false,
        error:
          "Driver authentication failed",
      });
    }
  }

  return {
    requireDriver,
  };
}

module.exports = createDriverAuth;