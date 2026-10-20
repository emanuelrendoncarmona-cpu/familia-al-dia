// /api/ai — asistente de la agenda, lectura de fotos y mensajes de la EPS, y ayuda de uso.
// Usa Netlify AI Gateway: no necesita clave propia; consume créditos de la cuenta de Netlify.
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "@netlify/functions";
import { requireUser, getCuenta, estadoCuenta, stores, json, AI_DAILY_LIMIT } from "../../lib/common.mts";

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
Si no sabes algo, dilo y sugiere escribir a emanuelrendoncarmona@gmail.com.`;

async function checkQuota(userId: string) {
  const key = `${userId}/${new Date().toISOString().slice(0, 10)}`;
  const s = stores.uso();
  const cur = ((await s.get(key, { type: "json" })) as { n: number } | null)?.n || 0;
  if (cur >= AI_DAILY_LIMIT) return false;
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
  const estado = estadoCuenta(await getCuenta(user));
  if (!estado.activo) return json({ error: "Tu prueba gratis terminó. Activa tu plan para usar el asistente.", code: "plan_vencido" }, 402);
  if (!process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_API_KEY) return json({ error: "El asistente aún no está activo en el servidor." }, 503);
  if (!(await checkQuota(user.id))) return json({ error: `Llegaste al límite de ${AI_DAILY_LIMIT} consultas de hoy. Mañana se renueva.`, code: "limite" }, 429);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
  const mode = body.mode;
  const hoy = String(body.hoy || new Date().toISOString().slice(0, 10)).slice(0, 30);
  const anthropic = new Anthropic();

  try {
    if (mode === "ayuda") {
      const q = String(body.q || "").slice(0, 1500);
      const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 500, system: HELP, messages: [{ role: "user", content: q }] });
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
      const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 700, system, messages: [{ role: "user", content: `Datos de la familia: ${ctx}\n\nEl usuario escribió: """${q}"""` }] });
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
      const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 700, messages: [{ role: "user", content }] });
      const out = msg.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
      return json(parseJSON(out));
    }

    return json({ error: "Modo desconocido." }, 400);
  } catch (e: any) {
    console.error("[ai]", e?.status, e?.message);
    return json({ error: "No pude responder en este momento. Intenta de nuevo en un minuto." }, 502);
  }
};

export const config: Config = { path: "/api/ai", method: "POST", rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] } };
