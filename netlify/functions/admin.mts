// /api/admin — panel para activar planes. Solo usuarios con el rol "admin" (se asigna en Netlify > Identity).
import type { Config } from "@netlify/functions";
import { requireUser, isAdmin, stores, estadoCuenta, json, PLANES, PRECIOS, registrarIngreso, ingresosMes, usoTotalMes, type Cuenta, type TipoPlan } from "../../lib/common.mts";
import { correos } from "../../lib/correo.mts";
import { correoActivo } from "../../lib/correo.mts";
import { vapidKeys, sendPush, pushStore, type Sub } from "../../lib/push.mts";

const sumarMes = (desde: number) => { const d = new Date(desde); return new Date(d.getFullYear(), d.getMonth() + 1, d.getDate(), 23, 59).toISOString(); };

// Cuando una familia invitada paga por primera vez, quien la invitó gana 1 mes gratis.
async function premiarReferido(c: Cuenta) {
  if (!c.referidoPor || c.refPremiado) return;
  const s = stores.cuentas();
  const r = (await s.get(c.referidoPor, { type: "json" })) as Cuenta | null;
  c.refPremiado = true;
  if (!r) return;
  const base = Math.max(Date.now(), r.pagoHasta ? Date.parse(r.pagoHasta) : 0, Date.parse(r.trialHasta) || 0);
  r.pagoHasta = sumarMes(base); r.referidosPagos = (r.referidosPagos || 0) + 1; r.avisoBorrado = null;
  await s.setJSON(r.userId, r);
  if (!vapidKeys()) return;
  const reg = ((await (await pushStore()).get(r.userId, { type: "json" })) as { subs: Sub[] } | null) || { subs: [] };
  for (const sub of reg.subs) { try { await sendPush(sub, { title: "¡Ganaste 1 mes gratis de FamiliSalud!", body: "Una familia que invitaste activó su plan. Gracias por recomendarnos.", tag: "referido", url: "/" }); } catch {} }
}

export default async (req: Request) => {
  const user = await requireUser();
  if (!user) return json({ error: "Inicia sesión." }, 401);
  if (!isAdmin(user)) return json({ error: "Solo administradores." }, 403);
  const s = stores.cuentas();

  if (req.method === "GET") {
    // Guardamos quién administra para avisarle por notificación de nuevas solicitudes de cita.
    const aj = stores.ajustes(); const adm = ((await aj.get("admins", { type: "json" })) as { ids: string[] } | null) || { ids: [] };
    if (!adm.ids.includes(user.id)) { adm.ids.push(user.id); await aj.setJSON("admins", adm); }
    const { blobs } = await s.list();
    const cuentas = (await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })))).filter(Boolean) as Cuenta[];
    const mail = new Map(cuentas.map(c => [c.userId, c.email]));
    const rows = cuentas.map(c => ({ userId: c.userId, email: c.email, creada: c.creada, notas: c.notas || "", ...estadoCuenta(c), pagoHasta: c.pagoHasta, trialHasta: c.trialHasta, invitadoPor: c.referidoPor ? mail.get(c.referidoPor) || "otra familia" : null, referidos: c.referidosPagos || 0 }))
      .sort((a, b) => b.creada.localeCompare(a.creada));
    const ing = await ingresosMes(); const uso = await usoTotalMes();
    const { blobs: gb } = await stores.gestiones().list({ prefix: "g/" });
    const gs = (await Promise.all(gb.map(b => stores.gestiones().get(b.key, { type: "json" })))).filter(Boolean) as any[];
    const resumen = { ingresosMes: ing.total, pagosMes: ing.items.filter((i: any) => i.valor > 0).length, asesoriasPendientes: gs.filter(g => g.estado === "pago" || g.estado === "proceso").length, asesoriasMes: gs.filter(g => String(g.creada).slice(0, 7) === new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 7)).length, usoIA: uso, correo: correoActivo(), vencenSemana: rows.filter(r => r.plan === "pago" && r.dias <= 7).length };
    return json({ resumen, cuentas: rows, total: rows.length, pagos: rows.filter(r => r.plan === "pago").length, prueba: rows.filter(r => r.plan === "prueba").length });
  }

  if (req.method === "POST") {
    let body: any; try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
    const c = (await s.get(String(body.userId || ""), { type: "json" })) as Cuenta | null;
    if (!c) return json({ error: "Cuenta no encontrada." }, 404);
    const base = c.pagoHasta && Date.parse(c.pagoHasta) > Date.now() ? new Date(c.pagoHasta) : new Date();
    if (body.accion === "plan") {
      const tipo = String(body.tipo || "") as TipoPlan;
      if (!PLANES[tipo]) return json({ error: "Plan desconocido." }, 400);
      c.tipo = tipo;
      const n = Number(body.cupo);
      c.cupo = tipo === "empresa" && Number.isFinite(n) && n >= 1 && n <= 200 ? Math.round(n) : PLANES[tipo].cupo;
    }
    else if (body.accion === "mes") c.pagoHasta = new Date(base.getFullYear(), base.getMonth() + 1, base.getDate(), 23, 59).toISOString();
    else if (body.accion === "anio") c.pagoHasta = new Date(base.getFullYear() + 1, base.getMonth(), base.getDate(), 23, 59).toISOString();
    else if (body.accion === "prueba7") c.trialHasta = new Date(Math.max(Date.now(), Date.parse(c.trialHasta)) + 7 * 864e5).toISOString();
    else if (body.accion === "quitar") c.pagoHasta = null;
    else if (body.accion === "restaurar") {
      const ok = (v: unknown) => v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));
      if (!ok(body.pagoHasta) || typeof body.trialHasta !== "string" || !ok(body.trialHasta)) return json({ error: "Datos inválidos." }, 400);
      c.pagoHasta = body.pagoHasta; c.trialHasta = body.trialHasta;
    }
    else return json({ error: "Acción desconocida." }, 400);
    if (typeof body.notas === "string") c.notas = body.notas.slice(0, 300);
    if (estadoCuenta(c).activo) { c.avisoBorrado = null; }
    if (body.accion === "mes" || body.accion === "anio") {
      await premiarReferido(c);
      await registrarIngreso(body.accion === "mes" ? "Plan mensual" : "Plan anual", body.accion === "mes" ? PRECIOS.mensual : PRECIOS.anual, c.email);
      if (c.pagoHasta) await correos.planActivo(c.email, c.pagoHasta);
    }
    if (body.accion === "restaurar" && (body.deshace === "mes" || body.deshace === "anio")) await registrarIngreso("Corrección (deshacer)", -(body.deshace === "mes" ? PRECIOS.mensual : PRECIOS.anual), c.email);
    await s.setJSON(c.userId, c);
    return json({ ok: true, cuenta: { ...c, ...estadoCuenta(c) } });
  }

  return json({ error: "Método no permitido" }, 405);
};

export const config: Config = { path: "/api/admin", method: ["GET", "POST"], rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] } };
