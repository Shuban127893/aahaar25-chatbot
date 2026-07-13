function createAdminAuth({
  pool,
  getCookie,
  adminApiKey,
}) {
  async function requireAdmin(
    req,
    res,
    next
  ) {
    try {
      if (
        adminApiKey &&
        req.headers["x-admin-key"] ===
          adminApiKey
      ) {
        return next();
      }

      const token = getCookie(
        req,
        "admin_session"
      );

      if (!token) {
        return res.status(401).json({
          success: false,
          error: "Admin login required",
        });
      }

      const result = await pool.query(
        `
        SELECT token
        FROM admin_sessions
        WHERE token = $1
          AND expires_at > NOW()
        LIMIT 1
        `,
        [token]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error:
            "Invalid or expired admin session",
        });
      }

      req.adminSession = {
        token,
      };

      return next();
    } catch (error) {
      console.error(
        "Admin authentication error:",
        error.message
      );

      return res.status(401).json({
        success: false,
        error:
          "Admin authentication failed",
      });
    }
  }

  async function requireAdminPage(
    req,
    res,
    next
  ) {
    try {
      const token = getCookie(
        req,
        "admin_session"
      );

      if (!token) {
        return res.redirect(
          "/admin-login"
        );
      }

      const result = await pool.query(
        `
        SELECT token
        FROM admin_sessions
        WHERE token = $1
          AND expires_at > NOW()
        LIMIT 1
        `,
        [token]
      );

      if (result.rows.length === 0) {
        return res.redirect(
          "/admin-login"
        );
      }

      req.adminSession = {
        token,
      };

      return next();
    } catch (error) {
      console.error(
        "Admin page authentication error:",
        error.message
      );

      return res.redirect(
        "/admin-login"
      );
    }
  }

  return {
    requireAdmin,
    requireAdminPage,
  };
}

module.exports = createAdminAuth;