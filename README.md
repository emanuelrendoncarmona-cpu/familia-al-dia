# Familia al Día

App web de Emnova para organizar las citas, órdenes, controles y medicamentos de la familia.

- `public/` — la app (HTML), página de privacidad, términos, íconos y service worker.
- `netlify/functions/` — servidor: `data` (agenda por usuario), `ai` (asistente y lectura de fotos con Netlify AI Gateway), `cal` (calendario suscrito .ics), `admin` (activar planes).
- `lib/common.mts` — utilidades compartidas (prueba de 14 días, cuentas, límites).

Requiere en Netlify: Identity activado (registro abierto, Google), un plan por créditos (AI Gateway) y el rol `admin` para el dueño.
Configuración de cobro: `const PAGO` en `public/index.html`.
