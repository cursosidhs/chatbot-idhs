# WhatsApp + Gemini Bot

Bot reactivo para WhatsApp Business (Cloud API) que responde usando Gemini.

## 1. Requisitos previos en Meta for Developers

1. En tu app de Meta, agregá el producto **WhatsApp** (ya hecho según lo que contás).
2. Anotá:
   - `Phone number ID` (panel de WhatsApp > API Setup).
   - `WhatsApp Business Account ID`.
3. Generá un **token permanente**:
   - Business Settings > Users > System Users > crear uno nuevo.
   - Asignale el activo (tu app de WhatsApp) con permiso de administrador.
   - Generá un token con los scopes `whatsapp_business_messaging` y `whatsapp_business_management`, sin expiración.
4. Conseguí el **App Secret**: App Dashboard > Settings > Basic > App Secret.

## 2. Gemini API key

1. Andá a [Google AI Studio](https://aistudio.google.com/) y generá una API key gratis.
2. Revisá los límites del free tier del modelo elegido (por defecto usamos `gemini-2.5-flash`).

## 3. Base de datos (Neon, gratis)

El bot necesita Postgres para que las conversaciones sobrevivan a los reinicios (el plan free de Render duerme el servicio a los 15 min, y sin base de datos la bandeja del empleado aparecería siempre vacía).

1. Creá una cuenta en [Neon](https://neon.tech) y un proyecto nuevo (no pide tarjeta).
2. Copiá el **connection string** del dashboard (el que termina en `?sslmode=require`).
3. Guardalo como `DATABASE_URL` en el `.env` del paso siguiente.

**Por qué Neon y no la base gratis de Render**: las bases free de Render **expiran a los 30 días**, dan 14 días de gracia y después Render las borra con todos los datos. El free tier de Neon no expira (0,5 GB, se apaga sola cuando no hay tráfico y se despierta al primer query).

> Ojo con Supabase como alternativa: desde febrero de 2026 pausa los proyectos tras 1 semana sin actividad y hay que despausarlos a mano desde el dashboard — mal combo para un bot que puede quedarse quieto un fin de semana largo.

Las tablas se crean solas al arrancar el server (`initSchema()` en `src/db.js`), no hay migraciones que correr.

## 4. Configurar variables de entorno

```bash
cp .env.example .env
```

Completá `.env` con:
- `WHATSAPP_TOKEN`: el token permanente del paso 1.
- `WHATSAPP_PHONE_NUMBER_ID`: del paso 1.
- `WHATSAPP_VERIFY_TOKEN`: inventá cualquier string random, lo vas a usar también en el panel de Meta.
- `WHATSAPP_APP_SECRET`: del paso 1.
- `GEMINI_API_KEY`: del paso 2.
- `DATABASE_URL`: el connection string de Neon del paso 3.
- `INBOX_USER` / `INBOX_PASSWORD`: usuario y contraseña con los que el empleado entra a `/inbox`. Poné una contraseña fuerte: **cualquiera que tenga estas credenciales puede mandar mensajes de WhatsApp en nombre del instituto.**

## 5. Instalar y correr localmente

```bash
npm install
npm run dev
```

El server levanta en `http://localhost:3000`.

## 6. Exponer el server con ngrok (para pruebas)

```bash
ngrok http 3000
```

Copiá la URL HTTPS que te da ngrok (ej. `https://abcd1234.ngrok-free.app`).

## 7. Configurar el webhook en Meta

En el panel de WhatsApp > Configuration:
- **Callback URL**: `https://<tu-url>/webhook`
- **Verify token**: el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`.
- Suscribite al campo `messages` (obligatorio), y si tenés coexistence activa, también `smb_message_echoes` (necesario para el punto 2 de comportamiento del bot, más abajo).

Si la verificación falla, revisá que el server esté corriendo y que el verify token coincida exactamente.

## 8. Probar

Desde tu celular, mandale un WhatsApp al número de prueba/producción configurado en Meta. El bot debería responder usando Gemini.

## Búsqueda de cursos

Además de responder, el bot puede buscar en la oferta académica real del instituto (scrapeando `https://idhs.org.ar/cursos-inscripcion/`) y devolver el link específico del curso que el usuario está preguntando.

Cómo funciona (`src/coursesStore.js`):
1. **Gate por palabras clave**: antes de llamar a Gemini, `looksLikeCourseQuery` revisa el mensaje entrante (sin importar tildes) buscando términos como "curso", "diplomatura", "taller", "inscripción", etc. Si el mensaje no parece sobre cursos, no se scrapea nada ni se agrega contexto extra — esto evita gastar tokens/rate-limit de Gemini en mensajes que no lo necesitan.
2. **Scraping + cache en memoria**: si el mensaje matchea, `getCourses()` devuelve el listado desde una cache en memoria (mismo patrón que `conversationStore.js`: sin persistencia, se resetea al reiniciar el proceso). Si la cache está vacía o vencida (`COURSES_CACHE_TTL_HOURS`, 12h por defecto), scrapea la página en ese momento y la vuelve a llenar. Llamadas concurrentes durante ese refresh comparten el mismo fetch en curso, así que no dispara múltiples scrapes en paralelo. Se excluyen los cursos con estado "Finalizado".
3. **Inyección al prompt**: el listado (título + link, y el estado si no es "Inscripción Abierta") se agrega al mensaje que se le manda a Gemini para esa llamada puntual — no se guarda en el historial de la conversación, así no se reenvía en cada turno siguiente. El `systemInstruction` de `src/gemini.js` le indica al modelo que use únicamente los cursos de ese bloque y no invente links.

Por qué así y no con un cron o una base de datos: en el free tier de Render el servicio se duerme a los 15 min de inactividad y tiene un tope de 750h/mes — un cron que lo despierte periódicamente para refrescar un cache quemaría horas gratis sin necesidad. La cache lazy con TTL logra lo mismo (evitar pegarle al sitio en cada mensaje) sin infraestructura extra, consistente con la filosofía "sin DB, todo en memoria" del proyecto.

Si la página cambia de estructura (clases CSS, HTML) el scraper puede dejar de encontrar cursos — en ese caso `getCourses()` loggea el error y sirve lo último cacheado (o una lista vacía si nunca pudo scrapear), sin tirar abajo el manejo del webhook.

Variables relacionadas (`.env`):
- `COURSES_URL`: URL de la página de listado a scrapear (default `https://idhs.org.ar/cursos-inscripcion/`).
- `COURSES_CACHE_TTL_HOURS`: horas que se sirve la cache antes de volver a scrapear (default 12).

## Bandeja del empleado (`/inbox`)

Para que una persona del equipo pueda leer y responder conversaciones sin necesitar la app de WhatsApp Business ni un servicio externo tipo Chatwoot, el mismo server expone una bandeja simple en `https://<tu-dominio>/inbox`.

- **Acceso**: HTTP Basic Auth con `INBOX_USER` / `INBOX_PASSWORD`. Andá directo a la URL y el navegador pide usuario y contraseña.
- **Listado**: conversaciones ordenadas por el último mensaje del cliente, con vista previa y una etiqueta "atendido por humano" en las que ya tomó un empleado.
- **Detalle**: el hilo completo, distinguiendo Cliente / Bot / Empleado, más un cuadro de texto para responder.
- **Al responder**: el mensaje sale por la Cloud API y la conversación queda marcada como `handed_off`, así que **el bot deja de contestar ahí** por el resto de la sesión (mismo efecto que la regla 3, pero disparado desde el panel en vez de por un echo de coexistence).
- **Ventana de 24 h**: si pasaron más de 24 h desde el último mensaje del cliente, el formulario se reemplaza por un aviso. WhatsApp no deja mandar texto libre fuera de esa ventana — haría falta una plantilla aprobada (con costo), que este panel todavía no envía.

Todos los mensajes entrantes se guardan **siempre**, incluso cuando el bot decide no responder. Es justamente el caso donde un humano necesita leer la conversación, así que una conversación derivada nunca aparece vacía en la bandeja.

### Seguridad

Quien tenga la contraseña de `/inbox` puede enviar WhatsApps en nombre del instituto. Dos cosas a tener en cuenta:
- Usá una contraseña larga y no la compartas por el mismo WhatsApp.
- Basic Auth manda las credenciales en cada request, así que **esto depende de HTTPS**. Render sirve HTTPS por defecto; no lo expongas por HTTP plano (ni por ngrok sin TLS).

## Comportamiento del bot

1. **Solo responde al arrancar la conversación**: el bot contesta durante los primeros `BOT_RESPONSE_WINDOW_MINUTES` (10 por defecto) desde el primer mensaje del cliente en una conversación. Pasado ese tiempo, queda en silencio para ese número hasta que se abra una conversación nueva.
2. **Qué cuenta como "conversación nueva"**: si el cliente estuvo en silencio más de `BOT_SESSION_GAP_HOURS` (6 por defecto), su próximo mensaje arranca una conversación nueva y el bot vuelve a estar activo por la ventana de respuesta.
3. **No pisa a un empleado**: cuando un empleado responde desde la bandeja `/inbox`, la conversación queda marcada como tomada por un humano y el bot deja de responder ahí por el resto de la sesión (hasta que se cumpla el punto 2). El mismo efecto se dispara vía el webhook `smb_message_echoes` si algún día activás coexistence y el empleado responde desde la app de WhatsApp Business; sin coexistence, ese camino simplemente no se usa y la bandeja cubre el caso.
4. **No inicia conversaciones**: el bot solo reacciona a mensajes entrantes de clientes (`messages`); nunca escribe primero, así que estructuralmente no puede "entrar" en una conversación que la empresa inició.

## 9. Deploy en Render (gratis)

1. Subí este repo a GitHub.
2. En Render: New > Web Service > conectá el repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Cargá las mismas variables de entorno del `.env` en la sección Environment de Render (incluidas `DATABASE_URL` e `INBOX_PASSWORD`).
5. Una vez desplegado, actualizá el **Callback URL** del webhook en Meta con el dominio de Render (`https://tu-app.onrender.com/webhook`).
6. La bandeja del empleado queda en `https://tu-app.onrender.com/inbox`.

## Notas

- El historial de conversación vive en Postgres (`src/conversationStore.js` + `src/db.js`) y sobrevive a reinicios y al sleep de Render. El cache de cursos (`src/coursesStore.js`) sigue siendo en memoria a propósito y se pierde al reiniciar; el próximo mensaje que pregunte por cursos dispara un scrape nuevo.
- Las conversaciones iniciadas por el usuario son gratis dentro de la ventana de 24 h. Si querés escribir primero vos, necesitás un template aprobado (con costo).
- El plan free de Render "duerme" el servicio tras 15 min de inactividad; el primer mensaje después de un rato puede tardar 30-60 s mientras arranca (y un poco más si además pregunta por cursos y toca scrapear). Si el empleado va a usar `/inbox` en vivo, considerá el plan Starter (~USD 7/mes) para evitar esa espera.
- **Costo total del stack tal como está**: USD 0. Render free + Neon free + Gemini free tier + mensajes de servicio de WhatsApp (gratis dentro de las 24 h). Lo único que cuesta plata es mandar plantillas fuera de esa ventana.
