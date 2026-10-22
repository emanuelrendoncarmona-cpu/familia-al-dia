// Revisión de fondo del directorio de EPS (hasta 15 minutos): comprueba que los enlaces oficiales abran y busca
// noticias recientes de la Supersalud sobre EPS liquidadas, intervenidas, retiradas o con traslados de afiliados.
// No cambia nada solo: guarda un informe y avisa al administrador para que decida.
import Anthropic from "@anthropic-ai/sdk";
import { stores } from "../../lib/common.mts";
import { avisar } from "../../lib/gestiones.mts";
import { leerDirectorio } from "../../lib/epsdir.mts";

const MODEL = "claude-haiku-5-5";

async function probar(u: string) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try { const r = await fetch(u, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 (FamiliSalud revisión de enlaces)" } }); return r.status; }
  catch { return 0; } finally { clearTimeout(t); }
}

export default async (req: Request) => {
  const aj = stores.ajustes();
  const token = await aj.get("revision-token");
  if (!token || req.headers.get("x-token") !== token) return new Response("no", { status: 403 });
  await aj.delete("revision-token");

  const d = await leerDirectorio();
  const enlaces: { eps: string; que: string; url: string }[] = [];
  for (const e of d?.lista || []) {
    if (e.estado && e.estado !== "activa") continue;
    for (const [que, p] of [["web", e.web], ["app", e.app], ["más canales", e.more ? ["", e.more] : null]] as const) if (p && (p as any)[1]) enlaces.push({ eps: e.n, que, url: (p as any)[1] });
  }
  const res = await Promise.all(enlaces.map(async x => ({ ...x, status: await probar(x.url) })));
  const rotos = res.filter(x => x.status === 404 || x.status === 410 || x.status >= 500 || x.status === 0);
  const bloqueados = res.filter(x => x.status === 401 || x.status === 403 || x.status === 429).length;

  let novedades: any[] = [], errorIA = "";
  if (process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_KEY) {
    try {
      const anthropic = new Anthropic();
      const hoy = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
      const conocidas = (d?.lista || []).map(e => e.n).join(", ");
      const messages: any[] = [{ role: "user", content: `Hoy es ${hoy}. Busca noticias de los últimos 45 días sobre EPS de Colombia: liquidaciones, intervenciones o vigilancia de la Superintendencia de Salud, retiros voluntarios de municipios, traslados o asignación de afiliados a otra EPS, EPS nuevas habilitadas, y cambios de líneas o canales de atención. EPS que tenemos registradas: ${conocidas}. Prefiere fuentes oficiales (supersalud.gov.co, minsalud.gov.co, sitios de las EPS) y medios reconocidos.` }];
      let msg: any;
      for (let turn = 0; turn < 3; turn++) {
        msg = await anthropic.messages.create({ model: MODEL, max_tokens: 8000, output_config: { effort: "low" }, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 } as any], messages } as any);
        if (msg.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: msg.content });
      }
      const texto = (msg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      const fmt = await anthropic.messages.create({ model: MODEL, max_tokens: 4000, output_config: { effort: "low" },
        system: 'Convierte a JSON válido: {"novedades":[{"eps":string,"tipo":"liquidacion"|"intervencion"|"retiro"|"traslado"|"nueva"|"canales"|"otra","resumen":"máximo 30 palabras","fecha":"YYYY-MM-DD" o null,"fuente":"url" o null}]}. Solo novedades concretas con fuente; si no hay, lista vacía. Solo el JSON.',
        messages: [{ role: "user", content: texto || "Sin resultados." }] } as any);
      const out = fmt.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
      const m = out.match(/\{[\s\S]*\}/); novedades = m ? (JSON.parse(m[0]).novedades || []).slice(0, 20) : [];
    } catch (e: any) { errorIA = String(e?.message || e).slice(0, 200); console.error("[eps-revision]", errorIA); }
  }

  const informe = { fecha: new Date().toISOString(), enlaces: res.length, rotos, bloqueados, novedades, errorIA };
  await aj.setJSON("eps-revision", informe);
  const admins = ((await aj.get("admins", { type: "json" })) as { ids: string[] } | null)?.ids || [];
  const partes = [novedades.length ? `${novedades.length} novedades de EPS` : "sin novedades de EPS", rotos.length ? `${rotos.length} enlaces que no abren` : "todos los enlaces abren"];
  await avisar(admins, { title: "Revisión mensual de EPS", body: `${partes.join(" y ")}. Revísalo en el panel > EPS.`, tag: "eps-revision", url: "/" });
  console.log("[eps-revision]", JSON.stringify({ enlaces: res.length, rotos: rotos.length, novedades: novedades.length }));
  return new Response("ok");
};
