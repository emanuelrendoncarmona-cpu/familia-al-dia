// Directorio de EPS editable desde el panel (sin desplegar). Si no existe, la app usa el directorio que trae incluido.
import { stores } from "./common.mts";
import { txt } from "./gestiones.mts";

export type Tel = [string, string];
export type EpsEntry = {
  k: string; n: string; patron: string; alias?: string; especial?: boolean;
  web?: [string, string] | null; app?: [string, string] | null; app2?: [string, string] | null; extra?: [string, string] | null;
  wa?: string; waName?: string; waCitas?: boolean; tels: Tel[] | { contributivo: Tel[]; subsidiado: Tel[] }; nota?: string; more?: string;
  estado?: "activa" | "liquidada" | "retirada"; destino?: string; avisoNota?: string; avisoFecha?: string;
};
export type Directorio = { version: number; actualizado: string; por: string; lista: EpsEntry[] };

const url = (v: unknown) => { const s = txt(v, 400); return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : ""; };
const par = (v: any): [string, string] | null => Array.isArray(v) && url(v[1]) ? [txt(v[0], 60) || "Abrir", url(v[1])] : null;
const tel = (v: any): Tel | null => Array.isArray(v) && /^[#+]?\d{3,15}$/.test(String(v[1] || "").replace(/\s/g, "")) ? [txt(v[0], 60) || "Línea", String(v[1]).replace(/\s/g, "")] : null;
const tels = (v: any): Tel[] => (Array.isArray(v) ? v : []).map(tel).filter(Boolean).slice(0, 60) as Tel[];

export function limpiarEntrada(e: any): EpsEntry | null {
  const k = txt(e?.k, 30).toLowerCase().replace(/[^a-z0-9-]/g, "");
  const n = txt(e?.n, 80);
  let patron = txt(e?.patron, 200);
  if (!k || !n) return null;
  try { new RegExp(patron || "x", "i"); } catch { patron = ""; }
  if (!patron) patron = n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const t = e?.tels && !Array.isArray(e.tels) && typeof e.tels === "object" ? { contributivo: tels(e.tels.contributivo), subsidiado: tels(e.tels.subsidiado) } : tels(e?.tels);
  const estado = ["activa", "liquidada", "retirada"].includes(e?.estado) ? e.estado : "activa";
  return {
    k, n, patron, alias: txt(e?.alias, 200), especial: !!e?.especial, web: par(e?.web), app: par(e?.app), app2: par(e?.app2), extra: par(e?.extra),
    wa: /^\d{10,13}$/.test(String(e?.wa || "")) ? String(e.wa) : "", waName: txt(e?.waName, 30), waCitas: !!e?.waCitas, tels: t,
    nota: txt(e?.nota, 400), more: url(e?.more), estado, destino: estado === "activa" ? "" : txt(e?.destino, 30), avisoNota: estado === "activa" ? "" : txt(e?.avisoNota, 400), avisoFecha: estado === "activa" ? "" : txt(e?.avisoFecha, 10),
  };
}

export async function leerDirectorio(): Promise<Directorio | null> {
  return (await stores.ajustes().get("eps-directorio", { type: "json" })) as Directorio | null;
}
export async function guardarDirectorio(d: Directorio) { await stores.ajustes().setJSON("eps-directorio", d); }
