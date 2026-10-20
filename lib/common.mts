// Utilidades compartidas por las funciones de Familia al Día.
import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";

export const TRIAL_DAYS = 14;
export const AI_DAILY_LIMIT = 40; // consultas de IA por usuario por día

export const stores = {
  agendas: () => getStore({ name: "agendas", consistency: "strong" }),
  cuentas: () => getStore({ name: "cuentas", consistency: "strong" }),
  calTokens: () => getStore({ name: "cal-tokens", consistency: "strong" }),
  uso: () => getStore({ name: "uso-ia", consistency: "strong" }),
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function requireUser() {
  const user = await getUser();
  if (!user || !user.id) return null;
  return user;
}

const randomToken = () => {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
};

export type Cuenta = { userId: string; email: string; creada: string; trialHasta: string; pagoHasta: string | null; calToken: string; notas?: string };

// Devuelve (y crea la primera vez) la cuenta del usuario con su prueba gratis y su token de calendario.
export async function getCuenta(user: { id: string; email?: string }): Promise<Cuenta> {
  const s = stores.cuentas();
  let c = (await s.get(user.id, { type: "json" })) as Cuenta | null;
  if (!c) {
    const now = new Date();
    const trial = new Date(now.getTime() + TRIAL_DAYS * 864e5);
    c = { userId: user.id, email: user.email || "", creada: now.toISOString(), trialHasta: trial.toISOString(), pagoHasta: null, calToken: randomToken() };
    await s.setJSON(user.id, c);
    await stores.calTokens().setJSON(c.calToken, { userId: user.id });
  } else if (user.email && c.email !== user.email) {
    c.email = user.email; await s.setJSON(user.id, c);
  }
  return c;
}

export function estadoCuenta(c: Cuenta) {
  const now = Date.now();
  const pagado = c.pagoHasta ? Date.parse(c.pagoHasta) > now : false;
  const enPrueba = Date.parse(c.trialHasta) > now;
  const activo = pagado || enPrueba;
  const hasta = pagado ? c.pagoHasta : c.trialHasta;
  const dias = Math.max(0, Math.ceil((Date.parse(hasta!) - now) / 864e5));
  return { activo, plan: pagado ? "pago" : enPrueba ? "prueba" : "vencido", hasta, dias };
}

export const isAdmin = (user: { roles?: string[] }) => Array.isArray(user.roles) && user.roles.includes("admin");
