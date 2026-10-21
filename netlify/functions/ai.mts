// /api/ai — asistente de la agenda, lectura de fotos y mensajes de la EPS, y ayuda de uso.
// Usa Netlify AI Gateway: no necesita clave propia; consume créditos de la cuenta de Netlify.
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "@netlify/functions";
import { requireUser, getCuenta, estadoCuenta, stores, json, AI_DAILY_LIMIT, resolveFamily } from "../../lib/common.mts";

const MODEL = "claude-haiku-5-5";
const TIPOS = "medica, odonto, examen, imagen, terapia, vacuna, colegio, tramite, otra";

const HELP = `Eres el asistente de ayuda de "Familia al Día", una app colombiana para organizar las citas de la familia. Responde en español, corto (máximo 6 líneas), cálido y claro, tuteando. No des consejos médicos ni legales específicos.
Cómo funciona la app:
- Inicio: muestra la próxima cita con cuenta regresiva, una franja de 14 días y avisos (citas cercanas, autorizaciones por vencer, controles, medicamentos y trámites esperando respuesta).
- Botón + (abajo al centro): pedir una cita a la EPS, guardar una cita que ya tienes, guardar una orden/autorización, anotar un control o un medicamento.
- Pedir cita: muestra los canales oficiales de la EPS de la persona (web, WhatsApp, app, teléfonos) y un texto de "qué decir". Si queda pendiente, se guarda en Salud > Trámites y avisa a los 5 días con una guía de reclamo (otro canal, PQRD ante la EPS, Superintendencia de Salud, tutela).
- Cada cita tiene lista de qué llevar, botón para Google Calendar y para enviarla por WhatsApp. Al marcarla como asistida pregunta si dejó un control o una orden nueva.
- Barra del asistente: escribe "cita de mi mamá el jueves a las 3 pm" y llena el formulario; también responde preguntas sobre tu agenda.
- Leer foto: en Nueva cita, "Leer mensaje o foto de la EPS" permite subir la foto de la orden o pegar el SMS.
- Familia: personas con su EPS, documento y alergias. Ajustes: tu cuenta y plan, conectar tu calendario (enlace de suscripción), exportar a Google Sheets (archivo CSV), copia de seguridad, privacidad, cerrar sesión, borrar datos.
- Conectar calendario: Ajustes > Conectar mi calendario > copiar enlace. En Google Calendar (computador): Otros calendarios > + > Desde URL > pegar. En iPhone: Ajustes > Calendario > Cuentas > Añadir cuenta > Otra > Añadir calendario suscrito. Google puede tardar varias horas en mostrar cambios.
- Plan: 14 días gratis; luego $9.900 COP al mes o $99.000 al año. Si vence, puedes ver y exportar tus datos pero no guardar cambios hasta activar el plan.
- Privacidad: los datos se guardan cifrados en Netlify, solo tú los ves con tu cuenta. Responsable: Emnova (emanuelrendoncarmona@gmail.com).
- Acceso familiar: en Familia > Quién tiene acceso, quien administra invita a cada integrante con su correo (puede editar o solo ver). La persona crea su cuenta con ese mismo correo y acepta la invitación. Todos ven la misma agenda.
- Citas particulares: botón + > Buscar cita particular. Busca opciones con precio y calificaciones, y enlaces para verificar al médico en ReTHUS y a la clínica en REPS.
- Recordatorios: en Familia > Ajustes > Recordatorios > Activar. Llega una notificación al celular 1 día antes y 1 hora antes de cada cita. Cada integrante los activa en su propio celular. En iPhone primero hay que instalar la app (Safari > Compartir > Agregar a inicio) y abrirla desde el ícono; necesita iOS 16.4 o más reciente.
- Guías: en Salud > Guías hay pasos y derechos para: cita demorada, medicamentos pendientes, MIPRES, portabilidad, cambio de EPS, incapacidades, cirugía programada, tutela y verificar médicos.
Si no sabes algo, dilo y sugiere escribir a emanuelrendoncarmona@gmail.com.`;

async function checkQuota(userId: string, kind = "", limit = AI_DAILY_LIMIT) {
  const key = `${userId}${kind}/${new Date().toISOString().slice(0, 10)}`;
  const s = stores.uso();
  const cur = ((await s.get(key, { type: "json" })) as { n: number } | null)?.n || 0;
  if (cur >= limit) return false;
  await s.setJSON(key, { n: cur + 1 });
  return true;
}

function parseJSON(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("sin json");
  return JSON.parse(m[0]);
}

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const user = await requireUser();
  if (!user) return json({ error: "Inicia sesión para usar el asistente." }, 401);
  const { fam } = await resolveFamily(user);
  if (!fam) return json({ error: "Primero acepta o rechaza tu invitación familiar." }, 409);
  const owner = fam.miembros.find(m => m.userId === fam.ownerId) || { userId: fam.ownerId, email: "" };
  const estado = estadoCuenta(await getCuenta({ id: owner.userId, email: owner.email }));
  if (!estado.activo) return json({ error: "Tu prueba gratis terminó. Activa tu plan para usar el asistente.", code: "plan_vencido" }, 402);
  if (!process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_API_KEY) return json({ error: "El asistente se está actualizando. Intenta de nuevo en un minuto." }, 503);
  if (!(await checkQuota(user.id))) return json({ error: `Llegaste al límite de ${AI_DAILY_LIMIT} consultas de hoy. Mañana se renueva.`, code: "limite" }, 429);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
  const mode = body.mode;
  const hoy = String(body.hoy || new Date().toISOString().slice(0, 10)).slice(0, 30);
  const anthropic = new Anthropic();

  try {
    if (mode === "ayuda") {
      const q = String(body.q || "").slice(0, 1500);
      const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 4000, output_config: { effort: "low" }, system: HELP, messages: [{ role: "user", content: q }] });
      const text = msg.content.map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
      return json({ texto: text });
    }

    if (mode === "agenda") {
      const q = String(body.q || "").slice(0, 1500);
      const ctx = JSON.stringify(body.ctx || {}).slice(0, 60000);
      const system = `Eres el asistente de una agenda familiar de citas en Colombia. Español claro y cálido, sin consejos médicos. Hoy es ${hoy}.
Devuelve SOLO un objeto JSON con UNA acción:
- Registrar cita: {"accion":"cita","persona":<nombre exacto o null>,"tipo":<uno de: ${TIPOS}>,"especialidad":string,"fecha":"YYYY-MM-DD","hora":"HH:MM" o null,"lugar":string o null,"requisitos":[strings]}
- Anotar control: {"accion":"control","persona":...,"especialidad":string,"fecha":"YYYY-MM-DD"}
- Guardar autorización: {"accion":"autorizacion","persona":...,"servicio":string,"numero":string o null,"vence":"YYYY-MM-DD" o null}
- Guardar medicamento: {"accion":"medicamento","persona":...,"nombre":string,"dosis":string o null,"frecuencia":string o null,"proxima":"YYYY-MM-DD" o null}
- Pregunta: {"accion":"respuesta","texto":"máximo 5 líneas, basada SOLO en los datos"}
Interpreta fechas relativas desde hoy. "Mi mamá", "mi papá" se emparejan por parentesco. No inventes datos.`;
      const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 4000, output_config: { effort: "low" }, system, messages: [{ role: "user", content: `Datos de la familia: ${ctx}\n\nEl usuario escribió: """${q}"""` }] });
      const text = msg.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
      return json(parseJSON(text));
    }

    if (mode === "foto") {
      const text = String(body.text || "").slice(0, 4000);
      const personas = Array.isArray(body.personas) ? body.personas.slice(0, 20).map(String) : [];
      const content: any[] = [];
      if (body.image && typeof body.image.data === "string") {
        const mt = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(body.image.media_type) ? body.image.media_type : "image/jpeg";
        if (body.image.data.length > 7_000_000) return json({ error: "La foto es muy pesada. Toma una más cercana o recórtala." }, 413);
        content.push({ type: "image", source: { type: "base64", media_type: mt, data: body.image.data } });
      }
      content.push({ type: "text", text: `Extrae los datos de una cita o de una orden médica/autorización a partir de ${body.image ? "la imagen adjunta (orden médica, autorización o captura de un mensaje)" : "este mensaje"}${text ? (body.image ? " y este texto:\n" : ":\n") + text : ""}
Contexto: Colombia, hoy es ${hoy}. Personas de la familia: ${personas.join(", ") || "(sin datos)"}. Tipos válidos: ${TIPOS}.
Devuelve SOLO JSON: {"persona": nombre exacto de la lista o null, "tipo", "especialidad", "fecha":"YYYY-MM-DD" o null (si no hay año, el próximo que ocurra), "hora":"HH:MM" o null, "lugar", "profesional", "requisitos":[...], "autorizacion":{"numero","vence"} o null}. Usa null si un dato no aparece. No inventes.` });
      const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 4000, output_config: { effort: "low" }, messages: [{ role: "user", content }] });
      const out = msg.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
      return json(parseJSON(out));
    }

    if (mode === "particular") {
      if (!(await checkQuota(user.id, "-busqueda", 8))) return json({ error: "Llegaste al límite de 8 búsquedas de hoy. Mañana se renueva.", code: "limite" }, 429);
      const esp = String(body.especialidad || "").slice(0, 120);
      const ciudad = String(body.ciudad || "").slice(0, 80);
      const modalidad = String(body.modalidad || "cualquiera").slice(0, 30);
      const presupuesto = String(body.presupuesto || "").slice(0, 40);
      const motivo = String(body.motivo || "").slice(0, 300);
      const system = `Eres un experto en navegar el sistema de salud de Colombia y ayudas a familias a encontrar atención PARTICULAR (pagada directamente, sin EPS). Usa la búsqueda web. No das diagnósticos ni recomendaciones médicas.
Busca opciones reales y vigentes para: ${esp} en ${ciudad || "Colombia"}; modalidad: ${modalidad}${presupuesto ? "; presupuesto aproximado: " + presupuesto : ""}${motivo ? "; contexto administrativo: " + motivo : ""}.
Prioriza: (1) clínicas, IPS y consultorios con sitio oficial o perfil en directorios reconocidos (como Doctoralia), (2) opciones con precio de consulta publicado, (3) buenas calificaciones con número de opiniones, (4) facilidad para agendar en línea o por WhatsApp.
REGLAS: solo incluye datos que aparezcan en los resultados de búsqueda; nunca inventes precios, teléfonos ni calificaciones (usa null si no aparecen). Los precios cambian: dilo tal como aparece y con su fuente.
Haz búsquedas distintas (por ejemplo: "${esp} particular ${ciudad} precio consulta", "${esp} ${ciudad} Doctoralia", "clínica ${esp} ${ciudad} agendar cita") para reunir entre 4 y 6 opciones de fuentes diferentes. Después de buscar, escribe una lista de máximo 6 opciones, de la mejor a la menos recomendada. Para cada una: nombre, tipo (médico, clínica o telemedicina), especialidad, dirección, teléfono, precio de consulta, calificación, cómo agendar y el enlace (URL) de la fuente. Al final da 2 consejos prácticos para pedir la cita particular.`;
      try {
        const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 } as any];
        const messages: any[] = [{ role: "user", content: `Busca opciones particulares de ${esp} en ${ciudad}.` }];
        let msg: any;
        for (let turn = 0; turn < 3; turn++) {
          msg = await anthropic.messages.create({ model: MODEL, max_tokens: 10000, output_config: { effort: "low" }, system, messages, tools } as any);
          if (msg.stop_reason !== "pause_turn") break;
          messages.push({ role: "assistant", content: msg.content });
        }
        const content: any[] = messages.slice(1).flatMap((m: any) => m.content).concat(msg.content || []);
        const blocks = content.filter((b: any) => b.type === "text");
        const text = blocks.map((b: any) => b.text).join("").trim();
        const found = content.filter((b: any) => b.type === "web_search_tool_result" && Array.isArray(b.content)).flatMap((b: any) => b.content).filter((r: any) => r.url).map((r: any) => `${r.title || ""} — ${r.url}`);
        const cites = [...new Set([...blocks.flatMap((b: any) => b.citations || []).filter((c: any) => c.url).map((c: any) => `${c.title || ""} — ${c.url}`), ...found])].slice(0, 30);
        const diag = { stop: msg.stop_reason, tipos: content.map((b: any) => b.type).join(","), texto: text.length, fuentes: cites.length };
        console.log("[ai particular]", JSON.stringify(diag));
        if (!text && !cites.length) return json({ error: "No encontramos resultados en internet para esa búsqueda. Prueba con otra especialidad o ciudad, o usa los enlaces de abajo.", code: "sin_resultados", diag }, 200);
        const fmt = await anthropic.messages.create({ model: MODEL, max_tokens: 6000, output_config: { effort: "low" }, system: `Convierte la información a JSON válido con esta forma exacta: {"opciones":[{"nombre":string,"tipo":"medico"|"clinica"|"telemedicina","especialidad":string,"direccion":string|null,"ciudad":string|null,"telefono":string|null,"precio":string|null,"calificacion":string|null,"como_agendar":string|null,"url":string,"fuente":string}],"consejos":[string,string]}. Usa SOLO datos que estén en el texto o en la lista de fuentes; null si falta un dato; nunca inventes precios, teléfonos ni calificaciones. "precio" corto, por ejemplo "Desde $250.000" o "$180.000". "calificacion" corta, por ejemplo "4,8 de 5 (120 opiniones)" o "27 opiniones", o null. "url" debe ser una de las fuentes y "fuente" su dominio. Si solo hay fuentes sin texto, crea una opción por cada fuente que sea un médico, clínica o directorio de salud de ${ciudad || "Colombia"} relacionado con ${esp}. Máximo 6 opciones. Responde únicamente el JSON.`, messages: [{ role: "user", content: `${text || "(sin texto)"}\n\nFuentes:\n${cites.join("\n")}` }] });
        const out: any = parseJSON(fmt.content.map((b: any) => (b.type === "text" ? b.text : "")).join(""));
        out.opciones = (Array.isArray(out.opciones) ? out.opciones : []).filter((o: any) => o && o.nombre && /^https?:\/\//.test(String(o.url || ""))).slice(0, 6);
        return json({ ...out, diag });
      } catch (e: any) {
        console.error("[ai particular]", e?.status, e?.message);
        return json({ error: "La búsqueda en internet no está disponible en este momento. Usa los enlaces de búsqueda de abajo.", code: "sin_busqueda" }, 503);
      }
    }

    return json({ error: "Modo desconocido." }, 400);
  } catch (e: any) {
    console.error("[ai]", e?.status, e?.message);
    return json({ error: "No pude responder en este momento. Intenta de nuevo en un minuto." }, 502);
  }
};

export const config: Config = { path: "/api/ai", method: "POST", rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] } };
