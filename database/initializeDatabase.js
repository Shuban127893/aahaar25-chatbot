const pool = require("../config/database");

async function initializeDatabase() {
  /*
  Orders
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
  Add any newer order columns safely
  when upgrading an older database.
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
  Drivers
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
  These ALTER statements upgrade an existing
  drivers table without deleting any drivers.
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
  Do not create a unique phone index yet.
  Your existing database contains duplicate
  test phone numbers.
  */

  /*
  Driver sessions
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

  /*
  Admin sessions
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  /*
  Driver activity
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

  /*
  Future WhatsApp OTP login codes
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

  /*
  Driver assignments
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

  /*
  Route progress
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

  /*
  Remove expired sessions and login codes.
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
}

module.exports = {
  initializeDatabase,
};