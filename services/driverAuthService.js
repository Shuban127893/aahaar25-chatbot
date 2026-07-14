const crypto = require("crypto");

/*
Normalize United States phone numbers.

Examples:

(978) 555-1234
978-555-1234
+1 978 555 1234

All become:

19785551234
*/

function normalizePhone(value = "") {
  let digits = String(value)
    .replace(/\D/g, "");

  if (digits.length === 10) {
    digits = `1${digits}`;
  }

  return digits;
}

/*
Generate a random six-digit
temporary login code.
*/

function generateSixDigitCode() {
  return String(
    crypto.randomInt(
      100000,
      1000000
    )
  );
}

/*
Hash a temporary login code before
saving it in PostgreSQL.
*/

function hashOneTimeCode(
  code,
  secret
) {
  if (!secret) {
    throw new Error(
      "OTP secret is required"
    );
  }

  return crypto
    .createHmac(
      "sha256",
      secret
    )
    .update(String(code))
    .digest("hex");
}

/*
Safely compare a submitted code
with its stored hash.
*/

function verifyOneTimeCodeHash(
  code,
  expectedHash,
  secret
) {
  if (
    !code ||
    !expectedHash ||
    !secret
  ) {
    return false;
  }

  const calculatedHash =
    hashOneTimeCode(
      code,
      secret
    );

  const expectedBuffer =
    Buffer.from(
      expectedHash,
      "hex"
    );

  const receivedBuffer =
    Buffer.from(
      calculatedHash,
      "hex"
    );

  if (
    expectedBuffer.length !==
    receivedBuffer.length
  ) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      expectedBuffer,
      receivedBuffer
    );
  } catch {
    return false;
  }
}

/*
Find exactly one active driver
associated with the submitted
phone number.

Returning null when duplicate phone
numbers exist prevents the wrong
driver account from being opened.
*/

async function findActiveDriverByPhone(
  pool,
  phone
) {
  const normalizedPhone =
    normalizePhone(phone);

  if (
    normalizedPhone.length < 10
  ) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT
      id,
      name,
      phone,
      is_active,
      created_at,
      last_login,
      phone_verified_at

    FROM drivers

    WHERE
      is_active = TRUE
      AND phone IS NOT NULL

    ORDER BY id ASC
    `
  );

  const matches =
    result.rows.filter(
      (driver) =>
        normalizePhone(
          driver.phone
        ) === normalizedPhone
    );

  if (matches.length !== 1) {
    return null;
  }

  return matches[0];
}

/*
Check whether another driver already
uses a phone number.

The optional excludedDriverId is useful
when editing an existing driver later.
*/

async function driverPhoneExists(
  pool,
  phone,
  excludedDriverId = null
) {
  const normalizedPhone =
    normalizePhone(phone);

  if (
    normalizedPhone.length < 10
  ) {
    return false;
  }

  const result = await pool.query(
    `
    SELECT
      id,
      phone

    FROM drivers

    WHERE phone IS NOT NULL
    `
  );

  return result.rows.some(
    (driver) => {
      if (
        excludedDriverId !== null &&
        Number(driver.id) ===
          Number(excludedDriverId)
      ) {
        return false;
      }

      return (
        normalizePhone(
          driver.phone
        ) === normalizedPhone
      );
    }
  );
}

/*
Create a temporary authenticated
driver session.
*/

async function createDriverSession(
  pool,
  driverId,
  sessionHours = 8
) {
  const token = crypto
    .randomBytes(32)
    .toString("hex");

  await pool.query(
    `
    INSERT INTO driver_sessions (
      token,
      driver_id,
      expires_at
    )
    VALUES (
      $1,
      $2,
      NOW() + ($3 * INTERVAL '1 hour')
    )
    `,
    [
      token,
      driverId,
      sessionHours,
    ]
  );

  await pool.query(
    `
    UPDATE drivers

    SET
      last_login = NOW(),
      phone_verified_at =
        COALESCE(
          phone_verified_at,
          NOW()
        )

    WHERE id = $1
    `,
    [driverId]
  );

  return token;
}

/*
Delete one browser session.
*/

async function deleteDriverSession(
  pool,
  token
) {
  if (!token) {
    return;
  }

  await pool.query(
    `
    DELETE FROM driver_sessions
    WHERE token = $1
    `,
    [token]
  );
}

/*
Delete every session belonging
to one driver.
*/

async function deleteAllDriverSessions(
  pool,
  driverId
) {
  await pool.query(
    `
    DELETE FROM driver_sessions
    WHERE driver_id = $1
    `,
    [driverId]
  );
}

/*
Delete every unused login code
belonging to one driver.
*/

async function deleteAllDriverLoginCodes(
  pool,
  driverId
) {
  await pool.query(
    `
    DELETE FROM driver_login_codes
    WHERE driver_id = $1
    `,
    [driverId]
  );
}

module.exports = {
  normalizePhone,
  generateSixDigitCode,
  hashOneTimeCode,
  verifyOneTimeCodeHash,
  findActiveDriverByPhone,
  driverPhoneExists,
  createDriverSession,
  deleteDriverSession,
  deleteAllDriverSessions,
  deleteAllDriverLoginCodes,
};