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

export type Cuenta = { userId: string; email: string; creada: string; trialHasta: string; pagoHasta: string | null; calToken: string; notas?: string; tipo?: TipoPlan; cupo?: number; avisoBorrado?: string | null; borrado?: string | null };

// Planes: cuántas personas pueden entrar con su propio correo a la agenda de la familia.
export type TipoPlan = "familiar" | "plus" | "empresa";
export const PLANES: Record<TipoPlan, { nombre: string; cupo: number }> = {
  familiar: { nombre: "Familiar", cupo: 4 },
  plus: { nombre: "Familiar Plus", cupo: 8 },
  empresa: { nombre: "Empresas", cupo: 8 },
};
export const cupoDe = (c: Cuenta | null | undefined) => Math.max(1, Math.min(200, Number(c?.cupo) || PLANES[c?.tipo || "familiar"]?.cupo || 4));
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
  return c;
}

export function estadoCuenta(c: Cuenta) {
  const now = Date.now();
  const pagado = c.pagoHasta ? Date.parse(c.pagoHasta) > now : false;
  const enPrueba = Date.parse(c.trialHasta) > now;
  const activo = pagado || enPrueba;
  const hasta = pagado ? c.pagoHasta : c.trialHasta;
  const dias = Math.max(0, Math.ceil((Date.parse(hasta!) - now) / 864e5));
  const tipo: TipoPlan = c.tipo && PLANES[c.tipo] ? c.tipo : "familiar";
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
