// /api/data — lee y guarda la agenda privada de cada usuario.
import type { Config } from "@netlify/functions";
import { requireUser, getCuenta, estadoCuenta, stores, json } from "../../lib/common.mts";

const MAX_BYTES = 900_000;

export default async (req: Request) => {
  const user = await requireUser();
  if (!user) return json({ error: "Inicia sesión para ver tu agenda." }, 401);
  const cuenta = await getCuenta(user);
  const estado = estadoCuenta(cuenta);
  const origin = new URL(req.url).origin;
  const calUrl = `${origin}/api/cal/${cuenta.calToken}`;

  if (req.method === "GET") {
    const agenda = await stores.agendas().get(user.id, { type: "json" });
    return json({ agenda: agenda || null, cuenta: { email: cuenta.email, creada: cuenta.creada, ...estado, calUrl }, admin: Array.isArray(user.roles) && user.roles.includes("admin") });
  }

  if (req.method === "PUT") {
    if (!estado.activo) return json({ error: "Tu prueba gratis terminó. Activa tu plan para seguir guardando cambios.", code: "plan_vencido" }, 402);
    const text = await req.text();
    if (text.length > MAX_BYTES) return json({ error: "La agenda es demasiado grande para guardarse." }, 413);
    let data: any;
    try { data = JSON.parse(text); } catch { return json({ error: "Datos inválidos." }, 400); }
    if (!data || !Array.isArray(data.miembros) || !Array.isArray(data.citas)) return json({ error: "Datos inválidos." }, 400);
    data.guardado = new Date().toISOString();
    await stores.agendas().setJSON(user.id, data);
    return json({ ok: true, guardado: data.guardado });
  }

  if (req.method === "DELETE") {
    await stores.agendas().delete(user.id);
    return json({ ok: true });
  }

  return json({ error: "Método no permitido" }, 405);
};

export const config: Config = { path: "/api/data", method: ["GET", "PUT", "DELETE"] };
