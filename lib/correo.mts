// Correos automáticos con Resend (https://resend.com). Se activan solos cuando existen las variables
// RESEND_API_KEY y EMAIL_FROM en Netlify; sin ellas no se envía nada (la app sigue funcionando igual).
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const correoActivo = () => !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

function plantilla(titulo: string, parrafos: string[], boton?: { texto: string; url: string }) {
  return `<!doctype html><html><body style="margin:0;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#122">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;padding:28px" cellpadding="0" cellspacing="0"><tr><td>
<p style="margin:0 0 4px;font-size:20px;font-weight:bold"><span style="color:#0B5CC4">Famili</span><span style="color:#2a9d6f">Salud</span></p>
<h1 style="font-size:22px;margin:18px 0 12px">${esc(titulo)}</h1>
${parrafos.map(p => `<p style="font-size:16px;line-height:1.5;margin:0 0 12px">${esc(p)}</p>`).join("")}
${boton ? `<p style="margin:22px 0"><a href="${esc(boton.url)}" style="background:#0B5CC4;color:#fff;text-decoration:none;padding:13px 22px;border-radius:12px;font-weight:bold;display:inline-block">${esc(boton.texto)}</a></p>` : ""}
<p style="font-size:13px;color:#667;margin:24px 0 0">FamiliSalud, de Emnova. Si no esperabas este correo, puedes ignorarlo.</p>
</td></tr></table></td></tr></table></body></html>`;
}

export async function enviarCorreo(para: string, asunto: string, titulo: string, parrafos: string[], boton?: { texto: string; url: string }) {
  if (!correoActivo() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(para || "")) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [para], subject: asunto, html: plantilla(titulo, parrafos, boton), text: [titulo, ...parrafos, boton ? `${boton.texto}: ${boton.url}` : ""].join("\n\n") }),
    });
    if (!r.ok) console.error("[correo]", r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e: any) { console.error("[correo]", e?.message); return false; }
}

const app = () => process.env.URL || "https://familisalud.netlify.app";
const fecha = (iso: string) => new Date(iso).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Bogota" });

export const correos = {
  bienvenida: (para: string) => enviarCorreo(para, "Bienvenido a FamiliSalud", "¡Bienvenido a FamiliSalud!", [
    "Ya tienes 14 días gratis para organizar las citas, órdenes y medicamentos de toda tu familia.",
    "Para empezar: agrega a las personas de tu familia, activa los recordatorios en tu celular y guarda la app en la pantalla de inicio.",
    "Si algún trámite con la EPS se te complica, en la app puedes pedir que un asesor lo haga por ti."], { texto: "Abrir FamiliSalud", url: app() }),
  pruebaPorVencer: (para: string, hasta: string) => enviarCorreo(para, "Te quedan 3 días de prueba en FamiliSalud", "Tu prueba gratis termina pronto", [
    `Tu prueba gratis termina el ${fecha(hasta)}. Después podrás ver y exportar tus datos, pero no guardar cambios ni usar el asistente.`,
    "El plan Familiar cuesta $14.900 al mes o $149.000 al año, para toda la familia y sin límite de personas. Se paga con Nequi o Bre-B."], { texto: "Ver mi plan", url: app() }),
  planActivo: (para: string, hasta: string) => enviarCorreo(para, "Tu plan de FamiliSalud está activo", "¡Listo! Tu plan está activo", [
    `Recibimos tu pago. Tu plan Familiar queda activo hasta el ${fecha(hasta)}.`, "Gracias por confiar en FamiliSalud."], { texto: "Abrir FamiliSalud", url: app() }),
  planPorVencer: (para: string, hasta: string, dias: number) => enviarCorreo(para, `Tu plan de FamiliSalud vence en ${dias} ${dias === 1 ? "día" : "días"}`, "Renueva tu plan", [
    `Tu plan vence el ${fecha(hasta)}. Renuévalo para no perder los recordatorios ni el asistente.`,
    "En la app, en Familia > Tu cuenta > Ver planes, está el QR de Nequi con el valor exacto."], { texto: "Renovar ahora", url: app() }),
};
