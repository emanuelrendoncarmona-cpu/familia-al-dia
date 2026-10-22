// Programada: el día 1 de cada mes a las 8 a. m. de Colombia lanza la revisión de fondo del directorio de EPS.
import type { Config } from "@netlify/functions";
import { stores } from "../../lib/common.mts";

export default async () => {
  const token = crypto.randomUUID(); await stores.ajustes().set("revision-token", token);
  const base = process.env.URL || "";
  if (!base) { console.error("[eps-mensual] sin URL"); return; }
  await fetch(`${base}/.netlify/functions/eps-revision-background`, { method: "POST", headers: { "x-token": token } }).catch(e => console.error("[eps-mensual]", e?.message));
};

export const config: Config = { schedule: "0 13 1 * *" };
