// Función programada (cada hora): hace seguimiento automático a los trámites del Asesor FamiliSalud.
// - Si la EPS no respondió un radicado dentro del plazo legal, avisa a la familia (con la queja lista en la app) y al asesor.
// - Una vez al día recuerda al asesor los trámites que esperan pago o que llevan más de un día sin moverse.
import type { Config } from "@netlify/functions";
import { stores, resolveFamily } from "../../lib/common.mts";
import { avisar, type Gestion } from "../../lib/gestiones.mts";

export default async () => {
  const gs = stores.gestiones(); const aj = stores.ajustes();
  const now = Date.now();
  const admins = ((await aj.get("admins", { type: "json" })) as { ids: string[] } | null)?.ids || [];
  const { blobs } = await gs.list({ prefix: "g/" });
  let vencidos = 0, sinPago = 0, quietos = 0;
  for (const { key } of blobs) {
    const g = (await gs.get(key, { type: "json" })) as Gestion | null;
    if (!g) continue;
    if (g.estado === "radicado" && g.radicado && !g.radicado.vencidoAviso && now > Date.parse(g.radicado.limite)) {
      g.radicado.vencidoAviso = true; await gs.setJSON(key, g); vencidos++;
      const fam = (await resolveFamily({ id: g.userId, email: g.email })).fam;
      const ids = fam ? fam.miembros.map(m => m.userId) : [g.userId];
      await avisar(ids, { title: "La EPS no respondió a tiempo", body: `Se venció el plazo del radicado N.° ${g.radicado.numero} (${g.que}). Abre la app: la queja ya está lista para enviar.`, tag: "gestion-" + g.id, url: "/" });
      await avisar(admins, { title: "Radicado vencido", body: `${g.persona.nombre} · ${g.que} · N.° ${g.radicado.numero}. Insiste con la EPS o pon la queja.`, tag: "admin-venc-" + g.id, url: "/" });
    }
    const quieto = now - Date.parse(g.actualizada || g.creada);
    if (g.estado === "pago" && quieto > 12 * 3600e3) sinPago++;
    if (g.estado === "proceso" && quieto > 24 * 3600e3) quietos++;
  }
  const hoy = new Date(now - 5 * 3600e3).toISOString().slice(0, 10);
  const hora = new Date(now - 5 * 3600e3).getUTCHours();
  if ((sinPago || quietos) && hora >= 8 && hora <= 20 && !(await aj.get(`aviso-admin/${hoy}`))) {
    await aj.set(`aviso-admin/${hoy}`, "1");
    const partes = [quietos ? `${quietos} en proceso hace más de 1 día` : "", sinPago ? `${sinPago} esperando pago` : ""].filter(Boolean).join(" y ");
    await avisar(admins, { title: "Asesorías pendientes", body: `Tienes ${partes}. Ábrelas en el panel de administración.`, tag: "admin-pendientes", url: "/" });
  }
  console.log("[seguimiento]", JSON.stringify({ vencidos, sinPago, quietos }));
};

export const config: Config = { schedule: "0 * * * *" };
