// /api/data — agenda compartida de la familia del usuario (con control de versiones para no pisar cambios).
import type { Config } from "@netlify/functions";
import { requireUser, getCuenta, estadoCuenta, stores, json, resolveFamily, familiaPublica } from "../../lib/common.mts";

const MAX_BYTES = 900_000;

export default async (req: Request) => {
  const user = await requireUser();
  if (!user) return json({ error: "Inicia sesión para ver tu agenda." }, 401);
  const { fam, rol, invite } = await resolveFamily(user);
  if (!fam) return json({ pendingInvite: invite ? { familia: invite.familia, por: invite.por, rol: invite.rol } : null, email: user.email });

  const owner = fam.miembros.find(m => m.userId === fam.ownerId) || { userId: fam.ownerId, email: "" };
  const cuenta = await getCuenta({ id: owner.userId, email: owner.email });
  const estado = estadoCuenta(cuenta);
  const origin = new URL(req.url).origin;
  const base = { cuenta: { email: user.email, dueno: owner.email, ...estado, calUrl: `${origin}/api/cal/${cuenta.calToken}` }, rol, familia: familiaPublica(fam, user.id), invitacion: invite ? { familia: invite.familia, por: invite.por, rol: invite.rol } : null, admin: Array.isArray(user.roles) && user.roles.includes("admin") };

  if (req.method === "GET") {
    const agenda: any = await stores.agendas().get(fam.id, { type: "json" });
    return json({ agenda: agenda || null, ...base });
  }

  if (req.method === "PUT") {
    if (rol === "lector") return json({ error: "Tienes acceso solo para ver. Pide a quien administra la familia que te dé permiso para editar.", code: "solo_lectura" }, 403);
    if (!estado.activo) return json({ error: "La prueba gratis de esta familia terminó. Activa el plan para seguir guardando cambios.", code: "plan_vencido" }, 402);
    const text = await req.text();
    if (text.length > MAX_BYTES) return json({ error: "La agenda es demasiado grande para guardarse." }, 413);
    let data: any;
    try { data = JSON.parse(text); } catch { return json({ error: "Datos inválidos." }, 400); }
    if (!data || !Array.isArray(data.miembros) || !Array.isArray(data.citas)) return json({ error: "Datos inválidos." }, 400);
    const current: any = await stores.agendas().get(fam.id, { type: "json" });
    const curVersion = Number(current?.version || 0);
    if (current && Number(data.version || 0) !== curVersion) return json({ error: "Alguien más cambió la agenda.", code: "conflicto", agenda: current }, 409);
    data.version = curVersion + 1;
    data.guardado = new Date().toISOString();
    data.guardadoPor = user.email || "";
    await stores.agendas().setJSON(fam.id, data);
    return json({ ok: true, guardado: data.guardado, version: data.version });
  }

  if (req.method === "DELETE") {
    if (rol !== "admin") return json({ error: "Solo quien administra la familia puede borrar los datos." }, 403);
    await stores.agendas().delete(fam.id);
    return json({ ok: true });
  }

  return json({ error: "Método no permitido" }, 405);
};

export const config: Config = { path: "/api/data", method: ["GET", "PUT", "DELETE"], rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] } };
