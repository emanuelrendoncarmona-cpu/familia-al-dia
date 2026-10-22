// /api/eps — directorio de EPS. GET: cualquiera (es información pública). POST: solo administradores, salvo "desconocida".
import type { Config } from "@netlify/functions";
import { requireUser, isAdmin, stores, json } from "../../lib/common.mts";
import { txt } from "../../lib/gestiones.mts";
import { leerDirectorio, guardarDirectorio, limpiarEntrada, type Directorio } from "../../lib/epsdir.mts";

const normNombre = (s: string) => txt(s, 60).replace(/\s+/g, " ").replace(/[<>"]/g, "");

export default async (req: Request) => {
  const aj = stores.ajustes();
  if (req.method === "GET") {
    const d = await leerDirectorio();
    return new Response(JSON.stringify(d ? { version: d.version, actualizado: d.actualizado, lista: d.lista } : { lista: null }),
      { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
  }
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const user = await requireUser();
  if (!user) return json({ error: "Inicia sesión." }, 401);
  let body: any; try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }

  // Cualquier usuario: avisar que escribió una EPS que no está en el directorio (solo el nombre, sin datos personales).
  if (body.accion === "desconocida") {
    const nombre = normNombre(body.nombre);
    if (nombre.length < 3) return json({ ok: true });
    const r = ((await aj.get("eps-desconocidas", { type: "json" })) as Record<string, { n: number; ultima: string }> | null) || {};
    const k = nombre.toLowerCase();
    if (!r[k] && Object.keys(r).length >= 300) return json({ ok: true });
    r[k] = { n: (r[k]?.n || 0) + 1, ultima: new Date().toISOString().slice(0, 10) };
    await aj.setJSON("eps-desconocidas", r);
    return json({ ok: true });
  }

  if (!isAdmin(user)) return json({ error: "Solo administradores." }, 403);
  const ahora = new Date().toISOString();
  const d: Directorio = (await leerDirectorio()) || { version: 0, actualizado: ahora, por: "", lista: [] };
  const guardar = async () => { d.version++; d.actualizado = ahora; d.por = user.email || ""; await guardarDirectorio(d); return json({ ok: true, version: d.version, lista: d.lista }); };

  if (body.accion === "info") {
    const desconocidas = ((await aj.get("eps-desconocidas", { type: "json" })) as Record<string, { n: number; ultima: string }> | null) || {};
    const revision = await aj.get("eps-revision", { type: "json" });
    return json({ hayDirectorio: d.version > 0, version: d.version, actualizado: d.actualizado, desconocidas, revision });
  }
  if (body.accion === "inicial") {
    if (d.version > 0) return json({ ok: true, version: d.version, lista: d.lista });
    d.lista = (Array.isArray(body.lista) ? body.lista : []).map(limpiarEntrada).filter(Boolean).slice(0, 150) as any;
    return guardar();
  }
  if (body.accion === "guardar") {
    const e = limpiarEntrada(body.entrada); if (!e) return json({ error: "Falta el nombre." }, 400);
    const i = d.lista.findIndex(x => x.k === e.k); if (i >= 0) d.lista[i] = e; else d.lista.push(e);
    if (body.quitarDesconocida) { const r = ((await aj.get("eps-desconocidas", { type: "json" })) as any) || {}; delete r[String(body.quitarDesconocida).toLowerCase()]; await aj.setJSON("eps-desconocidas", r); }
    return guardar();
  }
  if (body.accion === "quitar") { d.lista = d.lista.filter(x => x.k !== txt(body.k, 30)); return guardar(); }
  if (body.accion === "ignorar") { const r = ((await aj.get("eps-desconocidas", { type: "json" })) as any) || {}; delete r[String(body.nombre || "").toLowerCase()]; await aj.setJSON("eps-desconocidas", r); return json({ ok: true }); }
  if (body.accion === "revisar") {
    const token = crypto.randomUUID(); await aj.set("revision-token", token);
    const base = process.env.URL || new URL(req.url).origin;
    await fetch(`${base}/.netlify/functions/eps-revision-background`, { method: "POST", headers: { "x-token": token } }).catch(() => {});
    return json({ ok: true, mensaje: "Revisión en curso. Te llega una notificación en unos minutos." });
  }
  return json({ error: "Acción desconocida." }, 400);
};

export const config: Config = { path: "/api/eps", method: ["GET", "POST"], rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] } };
