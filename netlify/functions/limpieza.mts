// Función programada (diaria): aplica la regla de conservación de datos.
// Si el plan de una familia lleva más de RETENCION_DIAS vencido, se avisa en la app (y por notificación);
// si después de AVISO_DIAS sigue vencido, se borra la información de esa familia (Ley 1581: temporalidad).
import type { Config } from "@netlify/functions";
import { stores, famStores, estadoCuenta, emailKey, RETENCION_DIAS, AVISO_DIAS, type Cuenta, type Familia } from "../../lib/common.mts";
import { vapidKeys, sendPush, pushStore, type Sub } from "../../lib/push.mts";

const DIA = 864e5;
const fecha = (iso: string) => new Date(iso).toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Bogota" });

async function avisar(fam: Familia | null, ownerId: string, data: unknown) {
  if (!vapidKeys()) return;
  const subsStore = await pushStore();
  const ids = fam ? fam.miembros.map(m => m.userId) : [ownerId];
  for (const id of ids) {
    const reg = ((await subsStore.get(id, { type: "json" })) as { subs: Sub[] } | null) || { subs: [] };
    for (const sub of reg.subs) { try { await sendPush(sub, data, { ttl: 24 * 3600, urgency: "normal" }); } catch (e: any) { console.error("[limpieza] push", e?.message); } }
  }
}

export default async () => {
  const now = Date.now();
  const cuentas = stores.cuentas();
  const { blobs } = await cuentas.list();
  let avisos = 0, borrados = 0, reactivadas = 0;
  for (const { key } of blobs) {
    const c = (await cuentas.get(key, { type: "json" })) as Cuenta | null;
    if (!c || c.borrado) continue;
    const est = estadoCuenta(c);
    if (est.activo) {
      if (c.avisoBorrado) { c.avisoBorrado = null; await cuentas.setJSON(key, c); reactivadas++; }
      continue;
    }
    const vencioEl = Math.max(Date.parse(c.trialHasta) || 0, c.pagoHasta ? Date.parse(c.pagoHasta) || 0 : 0);
    if (now - vencioEl < RETENCION_DIAS * DIA) continue;
    const fam = (await famStores.familias().get(c.userId, { type: "json" })) as Familia | null;

    if (!c.avisoBorrado) {
      c.avisoBorrado = new Date(now).toISOString();
      await cuentas.setJSON(key, c); avisos++;
      const el = fecha(new Date(now + AVISO_DIAS * DIA).toISOString());
      await avisar(fam, c.userId, { title: "FamiliSalud: tu información se borrará pronto", body: `Tu plan lleva más de un año vencido. Si no lo renuevas antes del ${el}, borraremos la información de tu familia. Puedes exportarla desde la app.`, tag: "borrado", url: "/" });
      continue;
    }
    if (now - Date.parse(c.avisoBorrado) < AVISO_DIAS * DIA) continue;

    // Borrado: agenda de la familia, datos de la familia e invitaciones pendientes. La cuenta queda marcada como borrada.
    await stores.agendas().delete(c.userId);
    if (fam) {
      for (const inv of fam.invitaciones || []) await famStores.invites().delete(emailKey(inv.email));
      await famStores.familias().delete(c.userId);
    }
    const gs = stores.gestiones();
    for (const pre of [`g/${c.userId}/`, `foto/${c.userId}/`]) { const { blobs } = await gs.list({ prefix: pre }); for (const b of blobs) await gs.delete(b.key); }
    c.borrado = new Date(now).toISOString();
    await cuentas.setJSON(key, c); borrados++;
  }
  console.log("[limpieza]", JSON.stringify({ avisos, borrados, reactivadas }));
};

// Todos los días a las 4:00 a. m. de Colombia (9:00 UTC).
export const config: Config = { schedule: "0 9 * * *" };
