// Tipos y utilidades del servicio "Asesor FamiliSalud" (los usan /api/gestion y la función de seguimiento).
import { vapidKeys, sendPush, pushStore, type Sub } from "./push.mts";

export type Estado = "pago" | "proceso" | "radicado" | "lista" | "no";
export type Servicio = "cita" | "radicar" | "historia" | "traslado" | "otro";
export const SERVICIOS: Record<Servicio, string> = { cita: "Sacar una cita", radicar: "Radicar una orden o autorización", historia: "Pedir la historia clínica", traslado: "Transporte para cita en otra ciudad", otro: "Otro trámite con la EPS" };
export type Autorizacion = { numero: string; servicio: string; prestador: string; direccion: string; vence: string };
export type Gestion = {
  id: string; famId: string; userId: string; email: string; creada: string; actualizada: string; estado: Estado; precio: number; servicio: Servicio;
  persona: { id: string; nombre: string; tipoDoc: string; doc: string; eps: string; regimen: string; nac: string };
  que: string; ciudad: string; disponibilidad: string; telefono: string; notas: string; tieneFoto: boolean;
  correoEntrega?: string; relacion?: "propia" | "familiar" | "fallecido" | ""; viaje?: Record<string, string | boolean> | null;
  lectura?: Record<string, string | boolean | null> | null;
  radicado?: { numero: string; fecha: string; limite: string; mayor: boolean; vencidoAviso?: boolean } | null;
  resultado?: { fecha: string; hora: string; lugar: string; notas: string; autorizacion?: Autorizacion | null; aprobada?: boolean | null } | null;
  nota?: string; agregada?: boolean;
};

export const txt = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

// Edad en años a partir de "YYYY-MM-DD".
export function edad(nac: string, hoy = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nac || ""); if (!m) return null;
  let e = hoy.getUTCFullYear() - +m[1]; if (hoy.getUTCMonth() + 1 < +m[2] || (hoy.getUTCMonth() + 1 === +m[2] && hoy.getUTCDate() < +m[3])) e--; return e;
}

// Plazo legal para responder una autorización (Circular Conjunta 019 de 2025 y art. 125 del Decreto Ley 019 de 2012):
// 2 días hábiles para adultos mayores (60+) y otras poblaciones de especial protección; 5 días calendario para los demás.
// No descuenta festivos (es una guía; en festivos el plazo real puede ser un día mayor).
// Historia clínica: es un derecho de petición de documentos, 10 días hábiles (Ley 1755 de 2015, art. 14).
export function plazoRespuesta(nac: string, desde = new Date(), servicio: Servicio = "radicar") {
  const mayor = (edad(nac, desde) ?? 0) >= 60;
  const d = new Date(desde.getTime() - 5 * 3600e3); // fecha en Colombia
  const habiles = (n0: number) => { let n = 0; while (n < n0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; } };
  if (servicio === "historia") habiles(10);
  else if (mayor) habiles(2);
  else d.setUTCDate(d.getUTCDate() + 5);
  const dia = d.toISOString().slice(0, 10);
  return { mayor, limite: new Date(`${dia}T23:59:00-05:00`).toISOString() };
}

export async function avisar(userIds: string[], data: unknown) {
  if (!vapidKeys()) return;
  const ps = await pushStore();
  for (const id of userIds) {
    const reg = ((await ps.get(id, { type: "json" })) as { subs: Sub[] } | null) || { subs: [] };
    for (const sub of reg.subs) { try { await sendPush(sub, data, { ttl: 24 * 3600, urgency: "high" }); } catch (e: any) { console.error("[gestion] push", e?.message); } }
  }
}
