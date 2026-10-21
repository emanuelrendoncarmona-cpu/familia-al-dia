// /api/push — registrar este celular para recibir recordatorios, quitarlo o enviar una prueba.
import type { Config } from "@netlify/functions";
import { requireUser, json } from "../../lib/common.mts";
import { vapidKeys, sendPush, pushStore, type Sub } from "../../lib/push.mts";

type Reg = { subs: (Sub & { at: string; ua: string })[] };

export default async (req: Request) => {
  const user = await requireUser();
  if (!user) return json({ error: "Inicia sesión." }, 401);
  const keys = vapidKeys();
  const s = await pushStore();
  const reg = ((await s.get(user.id, { type: "json" })) as Reg | null) || { subs: [] };
  if (req.method === "GET") return json({ publicKey: keys?.pub || null, dispositivos: reg.subs.length });
  if (!keys) return json({ error: "Los recordatorios aún no están activos en el servidor." }, 503);
  let body: any; try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }

  if (body.accion === "suscribir") {
    const sub = body.sub as Sub;
    if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000 || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "Suscripción inválida." }, 400);
    reg.subs = reg.subs.filter(x => x.endpoint !== sub.endpoint);
    reg.subs.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, at: new Date().toISOString(), ua: String(req.headers.get("user-agent") || "").slice(0, 160) });
    reg.subs = reg.subs.slice(-6);
    await s.setJSON(user.id, reg);
    return json({ ok: true, dispositivos: reg.subs.length });
  }
  if (body.accion === "quitar") {
    reg.subs = reg.subs.filter(x => x.endpoint !== String(body.endpoint || ""));
    await s.setJSON(user.id, reg);
    return json({ ok: true, dispositivos: reg.subs.length });
  }
  if (body.accion === "prueba") {
    const sub = reg.subs.find(x => x.endpoint === String(body.endpoint || "")) || reg.subs[reg.subs.length - 1];
    if (!sub) return json({ error: "Este celular no tiene los recordatorios activados." }, 404);
    const status = await sendPush(sub, { title: "Al Día", body: "¡Listo! Así te llegarán los recordatorios: 1 día antes y 1 hora antes de cada cita.", tag: "prueba", url: "/" }, { ttl: 600 });
    if (status === 404 || status === 410) { reg.subs = reg.subs.filter(x => x.endpoint !== sub.endpoint); await s.setJSON(user.id, reg); return json({ error: "Este celular dejó de aceptar notificaciones. Actívalas de nuevo." }, 410); }
    if (status >= 300) { console.error("[push prueba]", status); return json({ error: "No se pudo enviar la prueba. Intenta de nuevo." }, 502); }
    return json({ ok: true });
  }
  return json({ error: "Acción desconocida." }, 400);
};

export const config: Config = { path: "/api/push", method: ["GET", "POST"], rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] } };
