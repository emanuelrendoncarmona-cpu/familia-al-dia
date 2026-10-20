// /api/family — invitar integrantes por correo, aceptar invitaciones, roles y salir de una familia.
import type { Config } from "@netlify/functions";
import { requireUser, json, resolveFamily, joinFamily, famStores, emailKey, familiaPublica, ROLES, type Familia, type Invite } from "../../lib/common.mts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async (req: Request) => {
  const user = await requireUser();
  if (!user) return json({ error: "Inicia sesión." }, 401);
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
  const fs = famStores.familias();

  if (body.accion === "aceptar") {
    const inv = (await famStores.invites().get(emailKey(user.email || ""), { type: "json" })) as Invite | null;
    if (!inv) return json({ error: "No tienes invitaciones pendientes." }, 404);
    const fam = await joinFamily(user, inv);
    if (!fam) return json({ error: "Esa familia ya no existe." }, 404);
    return json({ ok: true, familia: familiaPublica(fam, user.id) });
  }
  if (body.accion === "rechazar") {
    await famStores.invites().delete(emailKey(user.email || ""));
    const { fam } = await resolveFamily(user);
    return json({ ok: true, familia: fam ? familiaPublica(fam, user.id) : null });
  }

  const { fam, rol } = await resolveFamily(user);
  if (!fam) return json({ error: "Primero acepta o rechaza tu invitación." }, 409);
  const save = async (f: Familia) => { await fs.setJSON(f.id, f); return json({ ok: true, familia: familiaPublica(f, user.id) }); };

  if (body.accion === "salir") {
    if (fam.ownerId === user.id) return json({ error: "Eres quien creó esta familia; no puedes salir de ella." }, 400);
    fam.miembros = fam.miembros.filter(m => m.userId !== user.id);
    await fs.setJSON(fam.id, fam);
    await famStores.usuarios().delete(user.id);
    return json({ ok: true });
  }

  if (rol !== "admin") return json({ error: "Solo quien administra la familia puede hacer esto." }, 403);

  if (body.accion === "nombre") { fam.nombre = String(body.nombre || "").slice(0, 60); return save(fam); }

  if (body.accion === "invitar") {
    const email = String(body.email || "").trim().toLowerCase();
    const r = ROLES.includes(body.rol) ? body.rol : "editor";
    if (!EMAIL.test(email)) return json({ error: "Escribe un correo válido." }, 400);
    if (fam.miembros.some(m => m.email.toLowerCase() === email)) return json({ error: "Esa persona ya tiene acceso." }, 400);
    if (fam.miembros.length + fam.invitaciones.length >= 12) return json({ error: "Máximo 12 personas con acceso por familia." }, 400);
    const inv: Invite = { familyId: fam.id, rol: r, por: user.email || "", familia: fam.nombre, at: new Date().toISOString() };
    await famStores.invites().setJSON(emailKey(email), inv);
    fam.invitaciones = fam.invitaciones.filter(i => i.email !== email).concat({ email, rol: r, at: inv.at, por: inv.por });
    return save(fam);
  }
  if (body.accion === "cancelar") {
    const email = String(body.email || "").trim().toLowerCase();
    const cur = (await famStores.invites().get(emailKey(email), { type: "json" })) as Invite | null;
    if (cur && cur.familyId === fam.id) await famStores.invites().delete(emailKey(email));
    fam.invitaciones = fam.invitaciones.filter(i => i.email !== email);
    return save(fam);
  }
  if (body.accion === "rol" || body.accion === "quitar") {
    const m = fam.miembros.find(x => x.userId === body.userId);
    if (!m) return json({ error: "Esa persona no está en la familia." }, 404);
    if (m.userId === fam.ownerId) return json({ error: "No puedes cambiar a quien creó la familia." }, 400);
    if (body.accion === "rol") { if (!ROLES.includes(body.rol)) return json({ error: "Rol inválido." }, 400); m.rol = body.rol; }
    else { fam.miembros = fam.miembros.filter(x => x.userId !== m.userId); await famStores.usuarios().delete(m.userId); }
    return save(fam);
  }
  return json({ error: "Acción desconocida." }, 400);
};

export const config: Config = { path: "/api/family", method: "POST" };
