// Programada (diaria, 9 a. m. Colombia): avisa por notificación y por correo cuando la prueba gratis o el plan están por vencer.
import type { Config } from "@netlify/functions";
import { stores, famStores, estadoCuenta, type Cuenta, type Familia } from "../../lib/common.mts";
import { avisar } from "../../lib/gestiones.mts";
import { correos } from "../../lib/correo.mts";

export default async () => {
  const cuentas = stores.cuentas(); const aj = stores.ajustes();
  const { blobs } = await cuentas.list();
  const keys = blobs.map(b => b.key).sort();
  const desde = String((await aj.get("avisos-cuenta-cursor")) || ""); const ini = keys.findIndex(k => k > desde);
  const orden = ini > 0 ? [...keys.slice(ini), ...keys.slice(0, ini)] : keys;
  const t0 = Date.now(); let enviados = 0, ultimo = "";
  for (const key of orden) {
    if (Date.now() - t0 > 22000) { await aj.set("avisos-cuenta-cursor", ultimo); break; }
    ultimo = key;
    const c = (await cuentas.get(key, { type: "json" })) as (Cuenta & { avisoPrueba?: string; avisoRenov?: string }) | null;
    if (!c || c.borrado) continue;
    const e = estadoCuenta(c); if (!e.activo) continue;
    const fam = (await famStores.familias().get(c.userId, { type: "json" })) as Familia | null;
    const admins = fam ? fam.miembros.filter(m => m.rol === "admin").map(m => m.userId) : [c.userId];
    if (e.plan === "prueba" && e.dias <= 3 && c.avisoPrueba !== c.trialHasta) {
      c.avisoPrueba = c.trialHasta; await cuentas.setJSON(key, c); enviados++;
      await avisar(admins, { title: `Te quedan ${e.dias} ${e.dias === 1 ? "día" : "días"} de prueba`, body: "Activa tu plan para seguir guardando citas y usando el asistente. Toca para ver el QR.", tag: "plan", url: "/" });
      await correos.pruebaPorVencer(c.email, c.trialHasta);
    }
    if (e.plan === "pago" && e.dias <= 3 && c.pagoHasta && c.avisoRenov !== c.pagoHasta) {
      c.avisoRenov = c.pagoHasta; await cuentas.setJSON(key, c); enviados++;
      await avisar(admins, { title: `Tu plan vence en ${e.dias} ${e.dias === 1 ? "día" : "días"}`, body: "Renuévalo para no perder los recordatorios. Toca para ver el QR de Nequi.", tag: "plan", url: "/" });
      await correos.planPorVencer(c.email, c.pagoHasta, e.dias);
    }
  }
  console.log("[avisos-cuenta] enviados", enviados);
};

export const config: Config = { schedule: "0 14 * * *" };
