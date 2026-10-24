const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_KEY_FILE = path.join(__dirname, ".factory-secrets", "device-token.key");

function deviceTokenKey(keyFile, create) {
  if (create) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw new Error("장치 토큰 보관 키가 올바르지 않습니다.");
  return key;
}

function sealDeviceToken(deviceId, token, keyFile = DEFAULT_KEY_FILE) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deviceTokenKey(keyFile, true), iv);
  cipher.setAAD(Buffer.from(deviceId, "utf8"));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function openDeviceToken(deviceId, stored, keyFile = DEFAULT_KEY_FILE) {
  const [version, encodedIv, encodedTag, encodedToken, extra] = String(stored).split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedToken || extra !== undefined) throw new Error("장치 토큰 보관 형식이 올바르지 않습니다.");
  const iv = Buffer.from(encodedIv, "base64");
  const tag = Buffer.from(encodedTag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("장치 토큰 보관 형식이 올바르지 않습니다.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deviceTokenKey(keyFile, false), iv);
  decipher.setAAD(Buffer.from(deviceId, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(encodedToken, "base64")), decipher.final()]).toString("utf8");
}

module.exports = { sealDeviceToken, openDeviceToken };