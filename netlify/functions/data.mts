// /api/data — agenda compartida de la familia del usuario (con control de versiones para no pisar cambios).
import type { Config } from "@netlify/functions";
import { requireUser, getCuenta, estadoCuenta, stores, json, resolveFamily, familiaPublica, usoMes, USO_MES, PRECIOS, indexarAgenda, type Cuenta } from "../../lib/common.mts";

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
  const esDueno = fam.ownerId === user.id;
  const nuevo = Date.now() - Date.parse(cuenta.creada) < 10 * 864e5;
  const extra = { uso: await usoMes(fam.id), limites: USO_MES, precios: PRECIOS, ...(esDueno ? { refCode: cuenta.refCode, referidos: cuenta.referidosPagos || 0, puedeReferido: nuevo && !cuenta.referidoPor && !cuenta.pagoHasta, referidoPor: !!cuenta.referidoPor } : {}) };
  const base = { cuenta: { email: user.email, dueno: owner.email, ...estado, ...extra, calUrl: `${origin}/api/cal/${cuenta.calToken}` }, rol, familia: familiaPublica(fam, user.id), invitacion: invite ? { familia: invite.familia, por: invite.por, rol: invite.rol } : null, admin: Array.isArray(user.roles) && user.roles.includes("admin") };

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
    try { await indexarAgenda(fam.id, data); } catch (e: any) { console.error("[data] indice", e?.message); }
    return json({ ok: true, guardado: data.guardado, version: data.version });
  }

  if (req.method === "POST") {
    // Registrar quién invitó a esta familia (solo cuentas nuevas, una vez, y nunca a sí misma).
    let body: any; try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
    if (body.accion !== "referido") return json({ error: "Acción desconocida." }, 400);
    if (!esDueno || !extra.puedeReferido) return json({ ok: false });
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    const ref = code ? ((await stores.referidos().get(code, { type: "json" })) as { userId: string } | null) : null;
    if (!ref || ref.userId === user.id) return json({ ok: false });
    const c = (await stores.cuentas().get(user.id, { type: "json" })) as Cuenta | null;
    if (!c || c.referidoPor) return json({ ok: false });
    c.referidoPor = ref.userId; await stores.cuentas().setJSON(user.id, c);
    return json({ ok: true });
  }

  if (req.method === "DELETE") {
    if (rol !== "admin") return json({ error: "Solo quien administra la familia puede borrar los datos." }, 403);
    await stores.agendas().delete(fam.id);
    try { await indexarAgenda(fam.id, null); } catch {}
    return json({ ok: true });
  }

  return json({ error: "Método no permitido" }, 405);
};

export const config: Config = { path: "/api/data", method: ["GET", "PUT", "POST", "DELETE"], rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] } };
