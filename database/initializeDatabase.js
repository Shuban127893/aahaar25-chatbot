const pool = require("../config/database");

async function initializeDatabase() {
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

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_phone_unique
    ON drivers(phone)
    WHERE phone IS NOT NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_sessions (
      token TEXT PRIMARY KEY,
      driver_id INTEGER REFERENCES drivers(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_activity (
      id SERIAL PRIMARY KEY,
      driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
      driver_name TEXT,
      action TEXT NOT NULL,
      stop TEXT,
      status TEXT,
      sent_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_login_codes (
      id BIGSERIAL PRIMARY KEY,
      driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
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
    CREATE TABLE IF NOT EXISTS driver_assignments (
      id BIGSERIAL PRIMARY KEY,
      day TEXT NOT NULL,
      stop TEXT NOT NULL,
      driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(day, stop)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS route_progress (
      id BIGSERIAL PRIMARY KEY,
      day TEXT NOT NULL,
      stop TEXT NOT NULL,
      driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'not_started',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(day, stop)
    );
  `);
}

module.exports = {
  initializeDatabase,
};