// Utilidades compartidas por las funciones de FamiliSalud.
import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";

export const TRIAL_DAYS = 14;
export const AI_DAILY_LIMIT = 40; // consultas de IA por usuario por día

export const stores = {
  agendas: () => getStore({ name: "agendas", consistency: "strong" }),
  cuentas: () => getStore({ name: "cuentas", consistency: "strong" }),
  calTokens: () => getStore({ name: "cal-tokens", consistency: "strong" }),
  uso: () => getStore({ name: "uso-ia", consistency: "strong" }),
  referidos: () => getStore({ name: "referidos", consistency: "strong" }),
  gestiones: () => getStore({ name: "gestiones", consistency: "strong" }),
  ajustes: () => getStore({ name: "ajustes", consistency: "strong" }),
  idxCitas: () => getStore({ name: "idx-citas", consistency: "strong" }),
};

// Índice de fechas con citas: el recordatorio solo revisa las familias con citas hoy o mañana,
// en vez de leer todas las agendas cada 10 minutos (así aguanta miles de familias).
export async function indexarAgenda(famId: string, agenda: any) {
  const s = stores.idxCitas();
  const hoy = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
  const nuevos = new Set<string>();
  for (const c of Array.isArray(agenda?.citas) ? agenda.citas : []) {
    if (!["pendiente", "confirmada"].includes(c?.estado) || !/^\d{4}-\d{2}-\d{2}$/.test(c?.fecha || "") || c.fecha < hoy) continue;
    nuevos.add(c.fecha);
  }
  if (agenda?.ejemplo) nuevos.clear();
  const prev = ((await s.get(`fam/${famId}`, { type: "json" })) as { dias: string[] } | null)?.dias || [];
  for (const d of prev) if (!nuevos.has(d)) await s.delete(`dia/${d}/${famId}`);
  for (const d of nuevos) if (!prev.includes(d)) await s.set(`dia/${d}/${famId}`, "1");
  await s.setJSON(`fam/${famId}`, { dias: [...nuevos].slice(0, 400) });
  // Familias con medicamentos que tienen horas de toma: el recordatorio las revisa cada 10 minutos.
  const conHoras = !agenda?.ejemplo && (Array.isArray(agenda?.meds) ? agenda.meds : []).some((m: any) => Array.isArray(m?.horas) && m.horas.length && m.aviso !== false);
  if (conHoras) await s.set(`meds/${famId}`, "1"); else await s.delete(`meds/${famId}`);
}

// Precios en pesos (los muestra la app; el plan se activa a mano desde el panel al ver el pago).
export const PRECIOS = { mensual: 14900, anual: 149000, gestion: 5000 }; // gestion = precio "desde"
// Asesor FamiliSalud: precio según la dificultad del trámite.
export const PRECIOS_GESTION: Record<string, number> = { cita: 5000, radicar: 8000, traslado: 8000, historia: 10000, otro: 10000 };

// Uso justo del asistente con IA por familia y por mes (cada consulta gasta créditos de Netlify).
export const USO_MES = { asistente: 150, busqueda: 15 };
const mesActual = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 7); // mes en hora de Colombia
export async function usoTotalMes() { return ((await stores.uso().get(`total/${mesActual()}`, { type: "json" })) as { asistente?: number; busqueda?: number } | null) || {}; }
// Registro de ingresos por mes (para el resumen del panel). valor negativo = devolución o corrección.
export async function registrarIngreso(concepto: string, valor: number, email: string) {
  const k = `ingresos/${mesActual()}`; const a = stores.ajustes();
  const r = ((await a.get(k, { type: "json" })) as { total: number; items: any[] } | null) || { total: 0, items: [] };
  r.total += valor; r.items.push({ fecha: new Date().toISOString(), concepto, valor, email }); r.items = r.items.slice(-500);
  await a.setJSON(k, r);
}
export async function ingresosMes() { return ((await stores.ajustes().get(`ingresos/${mesActual()}`, { type: "json" })) as { total: number; items: any[] } | null) || { total: 0, items: [] }; }
export async function usoMes(famId: string) {
  const u = (await stores.uso().get(`mes/${famId}/${mesActual()}`, { type: "json" })) as { asistente?: number; busqueda?: number } | null;
  return { asistente: u?.asistente || 0, busqueda: u?.busqueda || 0 };
}
export async function gastarUso(famId: string, tipo: "asistente" | "busqueda") {
  const key = `mes/${famId}/${mesActual()}`;
  const u = (await stores.uso().get(key, { type: "json" })) as { asistente?: number; busqueda?: number } | null || {};
  const n = (u[tipo] || 0);
  if (n >= USO_MES[tipo]) return false;
  u[tipo] = n + 1;
  await stores.uso().setJSON(key, u);
  try { const tk = `total/${mesActual()}`; const t = ((await stores.uso().get(tk, { type: "json" })) as any) || {}; t[tipo] = (t[tipo] || 0) + 1; await stores.uso().setJSON(tk, t); } catch {}
  return true;
}

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

export type Cuenta = { userId: string; email: string; creada: string; trialHasta: string; pagoHasta: string | null; calToken: string; notas?: string; tipo?: string; cupo?: number; avisoBorrado?: string | null; borrado?: string | null; refCode?: string; referidoPor?: string | null; refPremiado?: boolean; referidosPagos?: number };

// Plan Familiar: personas ilimitadas (con un tope alto solo para evitar abusos). Empresas: cupo a la medida.
export type TipoPlan = "familiar" | "empresa";
export const CUPO_FAMILIAR = 30;
export const PLANES: Record<TipoPlan, { nombre: string; cupo: number }> = {
  familiar: { nombre: "Familiar", cupo: CUPO_FAMILIAR },
  empresa: { nombre: "Empresas", cupo: CUPO_FAMILIAR },
};
const tipoDe = (c: Cuenta | null | undefined): TipoPlan => (c?.tipo === "empresa" ? "empresa" : "familiar");
export const cupoDe = (c: Cuenta | null | undefined) => tipoDe(c) === "empresa" ? Math.max(1, Math.min(500, Number(c?.cupo) || CUPO_FAMILIAR)) : CUPO_FAMILIAR;
export const RETENCION_DIAS = 365; // días con el plan vencido antes de avisar que se borrará la información
export const AVISO_DIAS = 30;      // días entre el aviso y el borrado

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
  if (!c.refCode) {
    // Código para invitar a otras familias (no revela nada de la cuenta).
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = new Uint8Array(6); crypto.getRandomValues(b);
    c.refCode = Array.from(b, x => abc[x % abc.length]).join("");
    await s.setJSON(user.id, c);
    await stores.referidos().setJSON(c.refCode, { userId: user.id });
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
  const tipo = tipoDe(c);
  const borraEl = c.avisoBorrado && !activo ? new Date(Date.parse(c.avisoBorrado) + AVISO_DIAS * 864e5).toISOString() : null;
  return { activo, plan: pagado ? "pago" : enPrueba ? "prueba" : "vencido", hasta, dias, tipo, tipoNombre: PLANES[tipo].nombre, cupo: cupoDe(c), borraEl, borrado: c.borrado || null };
}

export const isAdmin = (user: { roles?: string[] }) => Array.isArray(user.roles) && user.roles.includes("admin");

// ---------- Familias compartidas ----------
export type Rol = "admin" | "editor" | "lector";
export type Miembro = { userId: string; email: string; rol: Rol; desde: string };
export type Familia = { id: string; ownerId: string; nombre: string; miembros: Miembro[]; invitaciones: { email: string; rol: Rol; at: string; por: string }[] };
export type Invite = { familyId: string; rol: Rol; por: string; familia: string; at: string };

export const famStores = {
  familias: () => getStore({ name: "familias", consistency: "strong" }),
  usuarios: () => getStore({ name: "usuarios", consistency: "strong" }),
  invites: () => getStore({ name: "invitaciones", consistency: "strong" }),
};
export const emailKey = (e: string) => encodeURIComponent(String(e || "").trim().toLowerCase());
export const ROLES: Rol[] = ["admin", "editor", "lector"];

async function ownFamily(user: { id: string; email?: string }): Promise<Familia> {
  const fs = famStores.familias();
  let fam = (await fs.get(user.id, { type: "json" })) as Familia | null;
  const now = new Date().toISOString();
  if (!fam) fam = { id: user.id, ownerId: user.id, nombre: "", miembros: [], invitaciones: [] };
  if (!fam.miembros.some(m => m.userId === user.id)) fam.miembros.push({ userId: user.id, email: user.email || "", rol: "admin", desde: now });
  await fs.setJSON(fam.id, fam);
  await famStores.usuarios().setJSON(user.id, { familyId: fam.id });
  return fam;
}

// Devuelve la familia del usuario, o una invitación pendiente si aún no pertenece a ninguna.
export async function resolveFamily(user: { id: string; email?: string }): Promise<{ fam: Familia | null; rol: Rol | null; invite: Invite | null }> {
  const invite = user.email ? ((await famStores.invites().get(emailKey(user.email), { type: "json" })) as Invite | null) : null;
  const link = (await famStores.usuarios().get(user.id, { type: "json" })) as { familyId: string } | null;
  if (link) {
    const fam = (await famStores.familias().get(link.familyId, { type: "json" })) as Familia | null;
    const me = fam?.miembros.find(m => m.userId === user.id);
    if (fam && me) {
      if (me.email !== (user.email || me.email)) { me.email = user.email!; await famStores.familias().setJSON(fam.id, fam); }
      return { fam, rol: me.rol, invite: invite && invite.familyId !== fam.id ? invite : null };
    }
  }
  // Sin familia: si tiene una invitación pendiente, se le pregunta antes de crear la suya.
  const hadOwn = await famStores.familias().get(user.id, { type: "json" });
  const hadData = await stores.agendas().get(user.id, { type: "json" });
  if (invite && !hadOwn && !hadData) return { fam: null, rol: null, invite };
  const fam = await ownFamily(user);
  return { fam, rol: "admin", invite };
}

export async function joinFamily(user: { id: string; email?: string }, invite: Invite) {
  const fs = famStores.familias();
  const fam = (await fs.get(invite.familyId, { type: "json" })) as Familia | null;
  if (!fam) return null;
  fam.miembros = fam.miembros.filter(m => m.userId !== user.id);
  fam.miembros.push({ userId: user.id, email: user.email || "", rol: invite.rol, desde: new Date().toISOString() });
  fam.invitaciones = fam.invitaciones.filter(i => emailKey(i.email) !== emailKey(user.email || ""));
  await fs.setJSON(fam.id, fam);
  // Si tenía su propia familia, deja de ser miembro de ella (sus datos se conservan).
  const own = (await fs.get(user.id, { type: "json" })) as Familia | null;
  if (own && own.id !== fam.id) { own.miembros = own.miembros.filter(m => m.userId !== user.id || own.ownerId === user.id); await fs.setJSON(own.id, own); }
  await famStores.usuarios().setJSON(user.id, { familyId: fam.id });
  await famStores.invites().delete(emailKey(user.email || ""));
  return fam;
}

export const familiaPublica = (fam: Familia, userId: string) => ({
  id: fam.id, nombre: fam.nombre, esDueno: fam.ownerId === userId,
  miembros: fam.miembros.map(m => ({ userId: m.userId, email: m.email, rol: m.rol, desde: m.desde, yo: m.userId === userId, dueno: m.userId === fam.ownerId })),
  invitaciones: fam.invitaciones,
});
