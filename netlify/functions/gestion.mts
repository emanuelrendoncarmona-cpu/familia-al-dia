// /api/gestion — servicio "Te sacamos la cita": la familia pide que el equipo de FamiliSalud gestione una cita con la EPS.
// Flujo: pago (espera el pago) → proceso (pago recibido, gestionando) → lista (con fecha, hora y lugar) | no (no se pudo; se devuelve el dinero).
import type { Config } from "@netlify/functions";
import { requireUser, isAdmin, stores, json, resolveFamily, PRECIOS } from "../../lib/common.mts";
import { vapidKeys, sendPush, pushStore, type Sub } from "../../lib/push.mts";

type Estado = "pago" | "proceso" | "lista" | "no";
type Gestion = {
  id: string; famId: string; userId: string; email: string; creada: string; actualizada: string; estado: Estado; precio: number;
  persona: { id: string; nombre: string; tipoDoc: string; doc: string; eps: string; regimen: string; nac: string };
  que: string; ciudad: string; disponibilidad: string; telefono: string; notas: string; tieneFoto: boolean;
  resultado?: { fecha: string; hora: string; lugar: string; notas: string } | null; nota?: string; agregada?: boolean;
};

const txt = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const nuevoId = () => { const b = new Uint8Array(9); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); };
const publica = (g: Gestion) => g; // la familia ve todo lo suyo; la foto se pide aparte

async function avisar(userIds: string[], data: unknown) {
  if (!vapidKeys()) return;
  const ps = await pushStore();
  for (const id of userIds) {
    const reg = ((await ps.get(id, { type: "json" })) as { subs: Sub[] } | null) || { subs: [] };
    for (const sub of reg.subs) { try { await sendPush(sub, data, { ttl: 24 * 3600, urgency: "high" }); } catch (e: any) { console.error("[gestion] push", e?.message); } }
  }
}

export default async (req: Request) => {
  const user = await requireUser();
  if (!user) return json({ error: "Inicia sesión." }, 401);
  const gs = stores.gestiones();
  const url = new URL(req.url);
  const admin = isAdmin(user);

  // ---------- administración ----------
  if (url.searchParams.get("admin") === "1") {
    if (!admin) return json({ error: "Solo administradores." }, 403);
    if (req.method === "GET") {
      const foto = url.searchParams.get("foto");
      if (foto) { const f = await gs.get(`foto/${foto}`, { type: "json" }) as { media_type: string; data: string } | null; return f ? json(f) : json({ error: "Sin foto." }, 404); }
      const { blobs } = await gs.list({ prefix: "g/" });
      const all = (await Promise.all(blobs.map(b => gs.get(b.key, { type: "json" })))).filter(Boolean) as Gestion[];
      const orden: Record<Estado, number> = { proceso: 0, pago: 1, lista: 2, no: 3 };
      all.sort((a, b) => orden[a.estado] - orden[b.estado] || b.creada.localeCompare(a.creada));
      return json({ gestiones: all.slice(0, 150) });
    }
    if (req.method === "POST") {
      let body: any; try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
      const key = `g/${txt(body.famId, 80)}/${txt(body.id, 40)}`;
      const g = (await gs.get(key, { type: "json" })) as Gestion | null;
      if (!g) return json({ error: "Solicitud no encontrada." }, 404);
      const estado = body.estado as Estado;
      if (!["pago", "proceso", "lista", "no"].includes(estado)) return json({ error: "Estado inválido." }, 400);
      if (estado === "lista") {
        const r = body.resultado || {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.fecha || ""))) return json({ error: "Escribe la fecha de la cita." }, 400);
        g.resultado = { fecha: r.fecha, hora: /^\d{2}:\d{2}$/.test(String(r.hora || "")) ? r.hora : "", lugar: txt(r.lugar, 200), notas: txt(r.notas, 500) };
      }
      if (estado === "no") g.nota = txt(body.nota, 500) || "No fue posible conseguir la cita. Te devolvemos el dinero.";
      g.estado = estado; g.actualizada = new Date().toISOString();
      await gs.setJSON(key, g);
      if (estado === "lista" || estado === "no") await gs.delete(`foto/${g.famId}/${g.id}`); // la foto de la orden ya no se necesita
      const fam = (await resolveFamily({ id: g.userId, email: g.email })).fam;
      const ids = fam ? fam.miembros.map(m => m.userId) : [g.userId];
      const nombre = g.persona.nombre.split(" ")[0];
      const msg = estado === "lista" ? { title: `¡Cita lista para ${nombre}!`, body: `${g.que}: ${g.resultado!.fecha}${g.resultado!.hora ? " a las " + g.resultado!.hora : ""}. Ábrela para agregarla a tu agenda.` }
        : estado === "proceso" ? { title: "Recibimos tu pago", body: `Ya estamos gestionando la cita de ${g.que} para ${nombre}.` }
        : estado === "no" ? { title: "No pudimos conseguir la cita", body: g.nota! } : null;
      if (msg) await avisar(ids, { ...msg, tag: "gestion-" + g.id, url: "/" });
      return json({ ok: true, gestion: g });
    }
    return json({ error: "Método no permitido" }, 405);
  }

  // ---------- familia ----------
  const { fam, rol } = await resolveFamily(user);
  if (!fam) return json({ error: "Primero acepta o rechaza tu invitación familiar." }, 409);
  const prefix = `g/${fam.id}/`;

  if (req.method === "GET") {
    const { blobs } = await gs.list({ prefix });
    const list = (await Promise.all(blobs.map(b => gs.get(b.key, { type: "json" })))).filter(Boolean) as Gestion[];
    list.sort((a, b) => b.creada.localeCompare(a.creada));
    return json({ gestiones: list.slice(0, 40).map(publica), precio: PRECIOS.gestion });
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }

  if (body.accion === "crear") {
    if (rol === "lector") return json({ error: "Tienes acceso solo para ver. Pide a quien administra la familia que haga la solicitud." }, 403);
    const p = body.persona || {};
    const g: Gestion = {
      id: nuevoId(), famId: fam.id, userId: user.id, email: user.email || "", creada: new Date().toISOString(), actualizada: new Date().toISOString(), estado: "pago", precio: PRECIOS.gestion,
      persona: { id: txt(p.id, 40), nombre: txt(p.nombre, 100), tipoDoc: txt(p.tipoDoc, 10), doc: txt(p.doc, 20), eps: txt(p.eps, 80), regimen: txt(p.regimen, 20), nac: txt(p.nac, 10) },
      que: txt(body.que, 120), ciudad: txt(body.ciudad, 80), disponibilidad: txt(body.disponibilidad, 200), telefono: txt(body.telefono, 20), notas: txt(body.notas, 500), tieneFoto: false,
    };
    if (!g.persona.nombre || !g.que) return json({ error: "Dinos para quién es y qué cita necesitas." }, 400);
    if (!g.persona.doc || !g.persona.eps) return json({ error: "Para pedir la cita necesitamos el documento y la EPS de la persona. Agrégalos en Familia." }, 400);
    if (!/^\+?\d[\d ]{6,18}$/.test(g.telefono)) return json({ error: "Escribe un celular de contacto válido." }, 400);
    if (body.autoriza !== true) return json({ error: "Necesitamos tu autorización para gestionar la cita con la EPS." }, 400);
    const { blobs } = await gs.list({ prefix });
    const abiertas = (await Promise.all(blobs.map(b => gs.get(b.key, { type: "json" })))).filter((x: any) => x && (x.estado === "pago" || x.estado === "proceso")).length;
    if (abiertas >= 5) return json({ error: "Ya tienes 5 solicitudes abiertas. Espera a que terminemos alguna." }, 400);
    if (body.foto && typeof body.foto.data === "string") {
      if (body.foto.data.length > 1_500_000) return json({ error: "La foto es muy pesada." }, 413);
      await gs.setJSON(`foto/${fam.id}/${g.id}`, { media_type: "image/jpeg", data: body.foto.data });
      g.tieneFoto = true;
    }
    await gs.setJSON(prefix + g.id, g);
    const adm = ((await stores.ajustes().get("admins", { type: "json" })) as { ids: string[] } | null)?.ids || [];
    await avisar(adm, { title: "Nueva solicitud de cita", body: `${g.que} para ${g.persona.nombre} (${g.persona.eps}). Espera el pago de $${PRECIOS.gestion.toLocaleString("es-CO")}.`, tag: "admin-gestion", url: "/" });
    return json({ ok: true, gestion: g });
  }

  const key = prefix + txt(body.id, 40);
  const g = (await gs.get(key, { type: "json" })) as Gestion | null;
  if (!g) return json({ error: "Solicitud no encontrada." }, 404);
  if (body.accion === "cancelar") {
    if (g.estado !== "pago") return json({ error: "Ya recibimos el pago y estamos gestionando la cita. Escríbenos si quieres cancelarla." }, 400);
    await gs.delete(key); await gs.delete(`foto/${fam.id}/${g.id}`);
    return json({ ok: true });
  }
  if (body.accion === "agregada") { g.agregada = true; await gs.setJSON(key, g); return json({ ok: true, gestion: g }); }
  if (body.accion === "ocultar") { if (g.estado !== "lista" && g.estado !== "no") return json({ error: "Aún está abierta." }, 400); await gs.delete(key); return json({ ok: true }); }
  return json({ error: "Acción desconocida." }, 400);
};

export const config: Config = { path: "/api/gestion", method: ["GET", "POST"], rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ["ip", "domain"] } };
