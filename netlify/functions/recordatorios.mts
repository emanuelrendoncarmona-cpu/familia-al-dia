// Función programada: cada 10 minutos envía recordatorios 1 día antes y 1 hora antes de cada cita
// a todos los celulares registrados de los integrantes de la familia.
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { stores, famStores, estadoCuenta, type Familia, type Cuenta } from "../../lib/common.mts";
import { vapidKeys, sendPush, pushStore, type Sub } from "../../lib/push.mts";

const DIA = 864e5, HORA = 36e5, MIN = 6e4;
const ACTIVA = (c: any) => ["pendiente", "confirmada"].includes(c.estado) && /^\d{4}-\d{2}-\d{2}$/.test(c.fecha || "");
const cuando = (c: any) => Date.parse(`${c.fecha}T${/^\d{2}:\d{2}$/.test(c.hora || "") ? c.hora : "07:00"}:00-05:00`);
const hora12 = (h: string) => { const [H, M] = h.split(":").map(Number); return `${((H + 11) % 12) + 1}:${String(M).padStart(2, "0")} ${H < 12 ? "a. m." : "p. m."}`; };
const TIPOS: Record<string, string> = { medica: "Cita médica", odonto: "Odontología", examen: "Examen", imagen: "Imagen diagnóstica", terapia: "Terapia", vacuna: "Vacunación", colegio: "Colegio", tramite: "Trámite", otra: "Cita" };

export default async () => {
  const keys = vapidKeys(); if (!keys) { console.warn("[recordatorios] VAPID no configurado"); return; }
  const now = Date.now();
  const hoy = new Date(now - 5 * HORA).toISOString().slice(0, 10);
  const enviados = getStore({ name: "avisos-enviados", consistency: "strong" });
  const subsStore = await pushStore();
  const { blobs } = await stores.agendas().list();
  let total = 0;
  for (const { key: famId } of blobs) {
    const a: any = await stores.agendas().get(famId, { type: "json" });
    if (!a || a.ejemplo || !Array.isArray(a.citas)) continue;
    const due: { c: any; tipo: "dia" | "hora" }[] = [];
    for (const c of a.citas) {
      if (!ACTIVA(c)) continue;
      const t = cuando(c); const conHora = /^\d{2}:\d{2}$/.test(c.hora || "");
      if (conHora && now >= t - 70 * MIN && now < t) due.push({ c, tipo: "hora" });
      else if (now >= t - DIA - 10 * MIN && now < t - 2 * HORA) due.push({ c, tipo: "dia" });
    }
    if (!due.length) continue;
    const fam = (await famStores.familias().get(famId, { type: "json" })) as Familia | null;
    const owner = fam?.ownerId || famId;
    const cuenta = (await stores.cuentas().get(owner, { type: "json" })) as Cuenta | null;
    if (!cuenta || !estadoCuenta(cuenta).activo) continue;
    const userIds = fam ? fam.miembros.map(m => m.userId) : [famId];
    const regs = await Promise.all(userIds.map(async id => ({ id, reg: ((await subsStore.get(id, { type: "json" })) as { subs: Sub[] } | null) || { subs: [] } })));
    const who = (id: string) => (a.miembros || []).find((m: any) => m.id === id)?.nombre?.split(" ")[0] || "";
    for (const { c, tipo } of due) {
      const k = `${famId}/${c.id}-${tipo}-${c.fecha}-${c.hora || ""}`;
      if (await enviados.get(k)) continue;
      await enviados.set(k, new Date().toISOString());
      const titulo = c.especialidad || TIPOS[c.tipo] || "Cita";
      const persona = who(c.miembroId);
      const lleva = (c.req || []).filter((r: any) => !r.ok).map((r: any) => r.t).slice(0, 3);
      const data = tipo === "hora"
        ? { title: `En 1 hora: ${titulo}${persona ? " de " + persona : ""}`, body: [`${hora12(c.hora)}${c.lugar ? " · " + c.lugar : ""}`, lleva.length ? `Lleva: ${lleva.join(", ")}` : ""].filter(Boolean).join("\n"), tag: `cita-${c.id}`, url: "/" }
        : { title: `${c.fecha === hoy ? "Hoy" : "Mañana"}: ${titulo}${persona ? " de " + persona : ""}`, body: [`${c.hora ? hora12(c.hora) : "Hora por confirmar"}${c.lugar ? " · " + c.lugar : ""}`, lleva.length ? `Falta alistar: ${lleva.join(", ")}` : "Todo listo."].join("\n"), tag: `cita-${c.id}`, url: "/" };
      for (const r of regs) {
        const vivos: Sub[] = [];
        for (const sub of r.reg.subs) {
          try { const st = await sendPush(sub, data, { ttl: tipo === "hora" ? 3600 : 6 * 3600 }); if (st !== 404 && st !== 410) vivos.push(sub); if (st < 300) total++; else if (st !== 404 && st !== 410) console.error("[recordatorios] push", st); }
          catch (e: any) { vivos.push(sub); console.error("[recordatorios]", e?.message); }
        }
        if (vivos.length !== r.reg.subs.length) { r.reg.subs = vivos; await subsStore.setJSON(r.id, r.reg); }
      }
    }
  }
  console.log("[recordatorios] enviados", total);
};

export const config: Config = { schedule: "*/10 * * * *" };
