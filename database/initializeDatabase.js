const pool = require("../config/database");

async function initializeDatabase() {
  /*
  ============================================================
  ORDERS
  ============================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      day TEXT,
      stop TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      square_payment_link TEXT,
      square_payment_link_id TEXT,
      square_order_id TEXT,
      square_payment_id TEXT UNIQUE,
      square_receipt_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ
    );
  `);

  /*
  Upgrade older order tables safely.
  */

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS square_payment_link TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS square_payment_link_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS square_order_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS square_payment_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS square_receipt_url TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS delivery_date DATE;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_delivery_date
    ON orders(delivery_date);
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_phone
    ON orders(phone);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_status
    ON orders(status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_square_order_id
    ON orders(square_order_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_day_stop_status
    ON orders(day, stop, status);
  `);

  /*
  ============================================================
  DRIVERS
  ============================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS drivers (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_login TIMESTAMPTZ,
      invite_token_hash TEXT,
      invite_expires_at TIMESTAMPTZ,
      phone_verified_at TIMESTAMPTZ
    );
  `);

  /*
  Upgrade older driver tables safely.
  */

  await pool.query(`
    ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS phone TEXT;
  `);

  await pool.query(`
    ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS password_hash TEXT;
  `);

  await pool.query(`
    ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
  `);

  await pool.query(`
    ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
  `);

  await pool.query(`
    ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS invite_token_hash TEXT;
  `);

  await pool.query(`
    ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;
  `);

  await pool.query(`
    ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
  `);

  /*
  Driver passwords are no longer used.

  Drivers now authenticate using temporary
  WhatsApp verification codes, so this column
  must allow NULL values.
  */

  await pool.query(`
    ALTER TABLE drivers
    ALTER COLUMN password_hash DROP NOT NULL;
  `);

  /*
  Normalize any empty password values left
  from the previous password-login system.
  */

  await pool.query(`
    UPDATE drivers
    SET password_hash = NULL
    WHERE password_hash = '';
  `);

  /*
  Do not add a unique database index on phone yet.

  Older test data may contain duplicate phone
  numbers. The admin route prevents new duplicate
  phone numbers through application validation.
  */

  /*
  ============================================================
  DRIVER SESSIONS
  ============================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_sessions (
      token TEXT PRIMARY KEY,
      driver_id INTEGER
        REFERENCES drivers(id)
        ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_driver_sessions_driver
    ON driver_sessions(driver_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_driver_sessions_expires
    ON driver_sessions(expires_at);
  `);

  /*
  ============================================================
  ADMIN SESSIONS
  ============================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
    ON admin_sessions(expires_at);
  `);

  /*
  ============================================================
  DRIVER ACTIVITY
  ============================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_activity (
      id SERIAL PRIMARY KEY,
      driver_id INTEGER
        REFERENCES drivers(id)
        ON DELETE SET NULL,
      driver_name TEXT,
      action TEXT NOT NULL,
      stop TEXT,
      status TEXT,
      sent_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_driver_activity_created
    ON driver_activity(created_at DESC);
  `);

  /*
  ============================================================
  DRIVER LOGIN CODES
  ============================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_login_codes (
      id BIGSERIAL PRIMARY KEY,
      driver_id INTEGER NOT NULL
        REFERENCES drivers(id)
        ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_driver_codes_driver
    ON driver_login_codes(driver_id, expires_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_driver_codes_expires
    ON driver_login_codes(expires_at);
  `);

  /*
  ============================================================
  DRIVER ASSIGNMENTS
  ============================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_assignments (
      id BIGSERIAL PRIMARY KEY,
      day TEXT NOT NULL,
      stop TEXT NOT NULL,
      driver_id INTEGER
        REFERENCES drivers(id)
        ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(day, stop)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_driver_assignments_driver
    ON driver_assignments(driver_id);
  `);

  /*
  ============================================================
  ROUTE PROGRESS
  ============================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS route_progress (
      id BIGSERIAL PRIMARY KEY,
      day TEXT NOT NULL,
      stop TEXT NOT NULL,
      driver_id INTEGER
        REFERENCES drivers(id)
        ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'not_started',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(day, stop)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_route_progress_driver
    ON route_progress(driver_id);
  `);

  /*
  ============================================================
  BUSINESS DATA

  Stores the live delivery and menu data an
  admin edits through the dashboard.

  Railway rebuilds this app's filesystem from
  git on every deploy, so anything written only
  to delivery-info.json / menu-info.json would
  be silently lost on the next deploy. This
  table is the real, persistent source of truth;
  the JSON files remain only as the first-boot
  starting values.
  ============================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_data (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  /*
  ============================================================
  WHATSAPP SESSIONS
  ============================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      phone TEXT PRIMARY KEY,
      step TEXT NOT NULL,
      order_data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  /*
  ============================================================
  CLEANUP EXPIRED AUTHENTICATION RECORDS
  ============================================================
  */

  await pool.query(`
    DELETE FROM admin_sessions
    WHERE expires_at <= NOW();
  `);

  await pool.query(`
    DELETE FROM driver_sessions
    WHERE expires_at <= NOW();
  `);

  await pool.query(`
    DELETE FROM driver_login_codes
    WHERE expires_at <= NOW()
       OR used_at IS NOT NULL;
  `);

  await pool.query(`
    DELETE FROM whatsapp_sessions
    WHERE updated_at <= NOW() - INTERVAL '2 hours';
  `);
}

module.exports = {
  initializeDatabase,
};