const crypto = require("crypto");

function hashPassword(password) {
  const salt = crypto
    .randomBytes(16)
    .toString("hex");

  const hash = crypto
    .pbkdf2Sync(
      password,
      salt,
      100000,
      64,
      "sha512"
    )
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(
  password,
  storedPasswordHash
) {
  if (
    !storedPasswordHash ||
    !storedPasswordHash.includes(":")
  ) {
    return false;
  }

  const [
    salt,
    originalHash,
  ] = storedPasswordHash.split(":");

  if (!salt || !originalHash) {
    return false;
  }

  const calculatedHash = crypto
    .pbkdf2Sync(
      password,
      salt,
      100000,
      64,
      "sha512"
    )
    .toString("hex");

  const expectedBuffer =
    Buffer.from(originalHash);

  const receivedBuffer =
    Buffer.from(calculatedHash);

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

async function findActiveDriverByName(
  pool,
  name
) {
  const result = await pool.query(
    `
    SELECT *
    FROM drivers
    WHERE LOWER(name) = LOWER($1)
      AND is_active = TRUE
    LIMIT 1
    `,
    [name]
  );

  return result.rows[0] || null;
}

async function authenticateDriver(
  pool,
  name,
  password
) {
  const cleanName = String(
    name || ""
  ).trim();

  const cleanPassword = String(
    password || ""
  );

  if (!cleanName || !cleanPassword) {
    return null;
  }

  const driver =
    await findActiveDriverByName(
      pool,
      cleanName
    );

  if (!driver) {
    return null;
  }

  const passwordIsValid =
    verifyPassword(
      cleanPassword,
      driver.password_hash
    );

  if (!passwordIsValid) {
    return null;
  }

  return driver;
}

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
    SET last_login = NOW()
    WHERE id = $1
    `,
    [driverId]
  );

  return token;
}

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

function generateSixDigitCode() {
  return String(
    crypto.randomInt(
      100000,
      1000000
    )
  );
}

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

module.exports = {
  hashPassword,
  verifyPassword,
  findActiveDriverByName,
  authenticateDriver,
  createDriverSession,
  deleteDriverSession,
  deleteAllDriverSessions,
  generateSixDigitCode,
  hashOneTimeCode,
};