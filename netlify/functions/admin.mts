// /api/admin — panel para activar planes. Solo usuarios con el rol "admin" (se asigna en Netlify > Identity).
import type { Config } from "@netlify/functions";
import { requireUser, isAdmin, stores, estadoCuenta, json, PLANES, type Cuenta, type TipoPlan } from "../../lib/common.mts";

export default async (req: Request) => {
  const user = await requireUser();
  if (!user) return json({ error: "Inicia sesión." }, 401);
  if (!isAdmin(user)) return json({ error: "Solo administradores." }, 403);
  const s = stores.cuentas();

  if (req.method === "GET") {
    const { blobs } = await s.list();
    const cuentas = (await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })))).filter(Boolean) as Cuenta[];
    const rows = cuentas.map(c => ({ userId: c.userId, email: c.email, creada: c.creada, notas: c.notas || "", ...estadoCuenta(c), pagoHasta: c.pagoHasta, trialHasta: c.trialHasta }))
      .sort((a, b) => b.creada.localeCompare(a.creada));
    return json({ cuentas: rows, total: rows.length, pagos: rows.filter(r => r.plan === "pago").length, prueba: rows.filter(r => r.plan === "prueba").length });
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
    await s.setJSON(c.userId, c);
    return json({ ok: true, cuenta: { ...c, ...estadoCuenta(c) } });
  }

  return json({ error: "Método no permitido" }, 405);
};

export const config: Config = { path: "/api/admin", method: ["GET", "POST"], rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] } };
