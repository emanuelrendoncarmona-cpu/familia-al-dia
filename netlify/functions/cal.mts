// /api/cal/:token — calendario privado (iCalendar) para suscribirse desde Google Calendar o el iPhone.
import type { Config, Context } from "@netlify/functions";
import { stores } from "../../lib/common.mts";

const esc = (s: string) => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\;");
const fold = (line: string) => { const out: string[] = []; let l = line; while (l.length > 74) { out.push(l.slice(0, 74)); l = " " + l.slice(74); } out.push(l); return out.join("\r\n"); };
const dt = (fecha: string, hora: string) => `${fecha.replace(/-/g, "")}T${(hora || "08:00").replace(":", "")}00`;
const addMin = (fecha: string, hora: string, min: number) => { const [y, m, d] = fecha.split("-").map(Number); const [H, M] = (hora || "08:00").split(":").map(Number); const t = new Date(Date.UTC(y, m - 1, d, H, M + min)); const p = (n: number) => String(n).padStart(2, "0"); return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}T${p(t.getUTCHours())}${p(t.getUTCMinutes())}00`; };
const nextDay = (fecha: string) => { const [y, m, d] = fecha.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + 1)); return t.toISOString().slice(0, 10).replace(/-/g, ""); };
const TIPOS: Record<string, string> = { medica: "Cita médica", odonto: "Odontología", examen: "Examen de laboratorio", imagen: "Imagen diagnóstica", terapia: "Terapia", vacuna: "Vacunación", colegio: "Colegio", tramite: "Trámite", otra: "Cita" };

export default async (req: Request, context: Context) => {
  const token = String(context.params?.token || "").replace(/\.ics$/, "");
  if (!/^[a-f0-9]{48}$/.test(token)) return new Response("No encontrado", { status: 404 });
  const ref = (await stores.calTokens().get(token, { type: "json" })) as { userId: string } | null;
  if (!ref) return new Response("No encontrado", { status: 404 });
  const a: any = (await stores.agendas().get(ref.userId, { type: "json" })) || { miembros: [], citas: [], auts: [], controles: [] };
  const who = (id: string) => (a.miembros || []).find((m: any) => m.id === id)?.nombre || "";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const L: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Emnova//Familia al Dia//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Familia al Día", "X-WR-TIMEZONE:America/Bogota", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
    "BEGIN:VTIMEZONE", "TZID:America/Bogota", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0500", "TZNAME:-05", "END:STANDARD", "END:VTIMEZONE"];
  for (const c of a.citas || []) {
    if (!c.fecha || ["cancelada"].includes(c.estado)) continue;
    const title = `${c.especialidad || TIPOS[c.tipo] || "Cita"} · ${who(c.miembroId)}`;
    const desc = [c.acompana ? `Acompaña: ${c.acompana}` : "", (c.req || []).length ? `Llevar: ${c.req.map((r: any) => r.t).join(", ")}` : "", c.notas || ""].filter(Boolean).join("\n");
    L.push("BEGIN:VEVENT", `UID:cita-${c.id}@familiaaldia`, `DTSTAMP:${stamp}`, `DTSTART;TZID=America/Bogota:${dt(c.fecha, c.hora)}`, `DTEND;TZID=America/Bogota:${addMin(c.fecha, c.hora, 60)}`, fold(`SUMMARY:${esc(title)}`));
    if (c.lugar) L.push(fold(`LOCATION:${esc(c.lugar)}`));
    if (desc) L.push(fold(`DESCRIPTION:${esc(desc)}`));
    if (["asistida", "perdida"].includes(c.estado)) L.push("STATUS:CONFIRMED");
    L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Mañana tienes cita", "TRIGGER:-P1D", "END:VALARM", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Cita en 2 horas", "TRIGGER:-PT2H", "END:VALARM", "END:VEVENT");
  }
  for (const x of a.auts || []) {
    if (!x.vence || x.estado === "usada") continue;
    L.push("BEGIN:VEVENT", `UID:aut-${x.id}@familiaaldia`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${x.vence.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${nextDay(x.vence)}`, fold(`SUMMARY:${esc(`Vence autorización: ${x.servicio} · ${who(x.miembroId)}`)}`), "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Autorización por vencer", "TRIGGER:-P7D", "END:VALARM", "END:VEVENT");
  }
  for (const k of a.controles || []) {
    if (!k.fecha || k.estado !== "pendiente") continue;
    L.push("BEGIN:VEVENT", `UID:ctl-${k.id}@familiaaldia`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${k.fecha.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${nextDay(k.fecha)}`, fold(`SUMMARY:${esc(`Pedir cita de control: ${k.especialidad} · ${who(k.miembroId)}`)}`), "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Pide la cita de control", "TRIGGER:-P14D", "END:VALARM", "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return new Response(L.join("\r\n") + "\r\n", { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store", "content-disposition": "inline; filename=familia-al-dia.ics" } });
};

export const config: Config = { path: "/api/cal/:token", method: "GET", rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] } };
