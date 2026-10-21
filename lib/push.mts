// Web Push sin dependencias externas: cifrado aes128gcm (RFC 8291) y firma VAPID (RFC 8292).
import crypto from "node:crypto";

export type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(String(s || ""), "base64url");
const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();

export function vapidKeys() {
  const pub = process.env.VAPID_PUBLIC_KEY || "", priv = process.env.VAPID_PRIVATE_KEY || "";
  return pub && priv ? { pub, priv, subject: process.env.VAPID_SUBJECT || "mailto:emanuelrendoncarmona@gmail.com" } : null;
}

export function encrypt(sub: Sub, payload: Buffer, salt = crypto.randomBytes(16)) {
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("suscripción inválida");
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header.writeUInt8(65, 20);
  return Buffer.concat([header, asPublic, body]);
}

export function vapidAuth(endpoint: string, keys: { pub: string; priv: string; subject: string }) {
  const pub = unb64u(keys.pub);
  const key = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: keys.priv, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: keys.subject })));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.pub}`;
}

// Devuelve el código HTTP del servicio de notificaciones (201 = enviada; 404/410 = suscripción vencida).
export async function sendPush(sub: Sub, data: unknown, opts: { ttl?: number; urgency?: "normal" | "high" } = {}) {
  const keys = vapidKeys(); if (!keys) throw new Error("VAPID no configurado");
  const u = new URL(sub.endpoint); if (u.protocol !== "https:") throw new Error("endpoint inválido");
  const body = encrypt(sub, Buffer.from(JSON.stringify(data)));
  const res = await fetch(sub.endpoint, { method: "POST", headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(opts.ttl ?? 4 * 3600), Urgency: opts.urgency || "high", Authorization: vapidAuth(sub.endpoint, keys) }, body });
  return res.status;
}

export const pushStore = async () => (await import("@netlify/blobs")).getStore({ name: "push", consistency: "strong" });
