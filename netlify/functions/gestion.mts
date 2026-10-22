// /api/gestion — "Asesor FamiliSalud": la familia paga para que una persona del equipo haga un trámite con la EPS (sacar cita, radicar orden, pedir historia clínica u otro).
// Flujo: pago → proceso (pago recibido) → [radicado (esperando respuesta de la EPS, con plazo legal)] → lista | no (se devuelve el dinero).
import type { Config } from "@netlify/functions";
import { requireUser, isAdmin, stores, json, resolveFamily, PRECIOS } from "../../lib/common.mts";
import { SERVICIOS, avisar, txt, plazoRespuesta, type Estado, type Servicio, type Gestion } from "../../lib/gestiones.mts";

const nuevoId = () => { const b = new Uint8Array(9); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); };
const publica = (g: Gestion) => g; // la familia ve todo lo suyo; la foto se pide aparte
const fechaCO = (iso: string) => new Date(iso).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Bogota" });

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
      const orden: Record<Estado, number> = { proceso: 0, pago: 1, radicado: 2, lista: 3, no: 4 };
      all.sort((a, b) => orden[a.estado] - orden[b.estado] || b.creada.localeCompare(a.creada));
      return json({ gestiones: all.slice(0, 150) });
    }
    if (req.method === "POST") {
      let body: any; try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
      const key = `g/${txt(body.famId, 80)}/${txt(body.id, 40)}`;
      const g = (await gs.get(key, { type: "json" })) as Gestion | null;
      if (!g) return json({ error: "Solicitud no encontrada." }, 404);
      const estado = body.estado as Estado;
      if (!["pago", "proceso", "radicado", "lista", "no"].includes(estado)) return json({ error: "Estado inválido." }, 400);
      if (estado === "radicado") {
        const numero = txt(body.radicado?.numero, 60);
        if (!numero) return json({ error: "Escribe el número de radicado que dio la EPS." }, 400);
        const p = plazoRespuesta(g.persona.nac);
        g.radicado = { numero, fecha: new Date().toISOString(), limite: p.limite, mayor: p.mayor };
      }
      if (estado === "lista") {
        const r = body.resultado || {};
        const a = r.autorizacion || null;
        const aut = a && (txt(a.numero, 60) || txt(a.servicio, 160)) ? { numero: txt(a.numero, 60), servicio: txt(a.servicio, 160) || g.que, prestador: txt(a.prestador, 160), direccion: txt(a.direccion, 200), vence: /^\d{4}-\d{2}-\d{2}$/.test(String(a.vence || "")) ? a.vence : "" } : null;
        const conFecha = /^\d{4}-\d{2}-\d{2}$/.test(String(r.fecha || ""));
        if ((g.servicio || "cita") === "cita" && !conFecha) return json({ error: "Escribe la fecha de la cita." }, 400);
        if ((g.servicio || "cita") !== "cita" && !conFecha && !aut && !txt(r.notas, 500)) return json({ error: "Escribe el resultado para la familia (por ejemplo, el número de radicado)." }, 400);
        g.resultado = { fecha: conFecha ? r.fecha : "", hora: /^\d{2}:\d{2}$/.test(String(r.hora || "")) ? r.hora : "", lugar: txt(r.lugar, 200), notas: txt(r.notas, 500), autorizacion: aut, aprobada: typeof r.aprobada === "boolean" ? r.aprobada : aut ? true : null };
      }
      if (estado === "no") g.nota = txt(body.nota, 500) || "No fue posible completar el trámite. Te devolvemos el dinero.";
      g.estado = estado; g.actualizada = new Date().toISOString();
      await gs.setJSON(key, g);
      if (estado === "lista" || estado === "no") await gs.delete(`foto/${g.famId}/${g.id}`); // la foto de la orden ya no se necesita
      const fam = (await resolveFamily({ id: g.userId, email: g.email })).fam;
      const ids = fam ? fam.miembros.map(m => m.userId) : [g.userId];
      const nombre = g.persona.nombre.split(" ")[0];
      const esCita = (g.servicio || "cita") === "cita";
      const aut = g.resultado?.autorizacion;
      const msg = estado === "radicado" ? { title: `Orden radicada · ${nombre}`, body: `Radicado N.° ${g.radicado!.numero}. La EPS debe responder a más tardar el ${fechaCO(g.radicado!.limite)}. Te avisamos.` }
        : estado === "lista" && aut ? { title: `¡Autorización aprobada para ${nombre}!`, body: `${aut.servicio}${aut.prestador ? " en " + aut.prestador : ""}${aut.vence ? ". Vence el " + aut.vence : ""}. Ábrela para guardarla.`.slice(0, 200) }
        : estado === "lista" ? (esCita ? { title: `¡Cita lista para ${nombre}!`, body: `${g.que}: ${g.resultado!.fecha}${g.resultado!.hora ? " a las " + g.resultado!.hora : ""}. Ábrela para agregarla a tu agenda.` }
          : { title: `Trámite listo para ${nombre}`, body: `${SERVICIOS[g.servicio]}: ${g.resultado!.notas || "listo"}`.slice(0, 180) })
        : estado === "proceso" ? { title: "Recibimos tu pago", body: `Un asesor ya está haciendo el trámite (${SERVICIOS[g.servicio || "cita"].toLowerCase()}) para ${nombre}.` }
        : estado === "no" ? { title: esCita ? "No pudimos conseguir la cita" : "No pudimos completar el trámite", body: g.nota! } : null;
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
    const servicio: Servicio = (Object.keys(SERVICIOS) as Servicio[]).includes(body.servicio) ? body.servicio : "cita";
    const g: Gestion = {
      id: nuevoId(), famId: fam.id, userId: user.id, email: user.email || "", creada: new Date().toISOString(), actualizada: new Date().toISOString(), estado: "pago", precio: PRECIOS.gestion, servicio,
      persona: { id: txt(p.id, 40), nombre: txt(p.nombre, 100), tipoDoc: txt(p.tipoDoc, 10), doc: txt(p.doc, 20), eps: txt(p.eps, 80), regimen: txt(p.regimen, 20), nac: txt(p.nac, 10) },
      que: txt(body.que, 120), ciudad: txt(body.ciudad, 80), disponibilidad: txt(body.disponibilidad, 200), telefono: txt(body.telefono, 20), notas: txt(body.notas, 500), tieneFoto: false,
      lectura: body.lectura && typeof body.lectura === "object" ? Object.fromEntries(Object.entries(body.lectura).slice(0, 14).map(([k, v]) => [txt(k, 20), typeof v === "boolean" || v === null ? v : txt(v, 200)])) : null,
    };
    if (!g.persona.nombre || !g.que) return json({ error: "Dinos para quién es y qué necesitas." }, 400);
    if (servicio === "radicar" && !(body.foto && typeof body.foto.data === "string")) return json({ error: "Para radicar necesitamos la foto de la orden médica." }, 400);
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
    await avisar(adm, { title: `Nueva solicitud: ${SERVICIOS[servicio]}`, body: `${g.que} para ${g.persona.nombre} (${g.persona.eps}). Espera el pago de $${PRECIOS.gestion.toLocaleString("es-CO")}.`, tag: "admin-gestion", url: "/" });
    return json({ ok: true, gestion: g });
  }

  if (rol === "lector") return json({ error: "Tienes acceso solo para ver." }, 403);
  const key = prefix + txt(body.id, 40);
  const g = (await gs.get(key, { type: "json" })) as Gestion | null;
  if (!g) return json({ error: "Solicitud no encontrada." }, 404);
  if (body.accion === "cancelar") {
    if (g.estado !== "pago") return json({ error: "Ya recibimos el pago y estamos haciendo el trámite. Escríbenos si quieres cancelarla." }, 400);
    await gs.delete(key); await gs.delete(`foto/${fam.id}/${g.id}`);
    return json({ ok: true });
  }
  if (body.accion === "agregada") { g.agregada = true; await gs.setJSON(key, g); return json({ ok: true, gestion: g }); }
  if (body.accion === "ocultar") { if (g.estado !== "lista" && g.estado !== "no") return json({ error: "Aún está abierta." }, 400); await gs.delete(key); return json({ ok: true }); }
  return json({ error: "Acción desconocida." }, 400);
};

export const config: Config = { path: "/api/gestion", method: ["GET", "POST"], rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ["ip", "domain"] } };
