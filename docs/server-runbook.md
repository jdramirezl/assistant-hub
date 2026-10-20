# Servidor Alfred: runbook

El mapa del servidor de casa: qué corre, dónde vive cada cosa, cómo se opera y por qué está así.
El detalle de cada pieza sigue en su propio runbook:

- Hub: [README](../README.md) de este repo.
- MyFitnessPal (Mason): [mfp-weekly-sync/docs/mac-runbook.md](https://github.com/jdramirezl/mfp-weekly-sync/blob/main/docs/mac-runbook.md).
- Cinépolis: [cines-mx-mcp/docs/mac-runbook.md](https://github.com/jdramirezl/cines-mx-mcp/blob/main/docs/mac-runbook.md).

Estado revisado en vivo el 2026-10-20 (hub `60afba7`, mfp-weekly-sync `cdf6959`, cines-mx-mcp `cddca3d`).
Los bloques de comandos no llevan comentarios con `#`: zsh los rompe al pegarlos.

## 1. Qué corre

**Máquina:** MacBook Pro Intel (i7 6 núcleos, 16 GB), macOS 26.5.1, usuario `julian`, IP `192.168.1.90`.
Acceso desde la laptop: `ssh alfred-mac` (solo llave; contraseña rechazada).

| LaunchAgent | Qué hace | Cuándo | Puerto |
|---|---|---|---|
| `com.jdrami.assistant-hub` | Hub (Mastra + Telegram long polling), `node .mastra/output/index.mjs` | siempre (KeepAlive) | 127.0.0.1:4111 |
| `com.jdrami.assistant-hub.backup` | snapshot de `mastra.db` a iCloud, guarda 7 | 03:15 diario | — |
| `com.jdrami.mfp-mcp` | Mason (`mfp-mcp --http`), vía `mason-run.sh` | siempre (KeepAlive) | 127.0.0.1:8484 |
| `com.jdrami.mfp-health` | health MFP; auto-cura (refresh → re-login); 🔴/🟢 en Telegram al cambiar | 03/09/15/21:00 + login | — |
| `com.jdrami.mfp-refresh` | renueva la sesión MFP | domingo 04:30 | — |
| `com.jdrami.cines-mcp` | cines-mx-mcp (`dist/server.js`, copia en Application Support) | siempre (KeepAlive) | 127.0.0.1:8686 |
| `com.jdrami.cines-health` | health Cinépolis; 🔴/🟢 al cambiar | 03/09/15/21:10 + login | — |

Fuera del Mac:

- **Finanzas:** `https://finance-app-backend-ten.vercel.app/mcp` (Vercel + Supabase), bearer token.
- **Gemini:** proyecto prod `PersonalAssistant` (`GOOGLE_API_KEY`) y proyecto dev `AssistantDev` (`DEV_GOOGLE_API_KEY` / `REPLAY_GOOGLE_API_KEY`).
- **Telegram:** prod **@jdrami_hub_bot** (servidor), dev **@jdrami_hub_dev_bot** (laptop, `npm run dev`). Tokens distintos.
- **healthchecks.io:** el hub hace ping cada 5 min a `HEALTHCHECK_URL` (configurado el 2026-10-20). Periodo 5 min, gracia 10 min.
- **Debug server** (a mano, no LaunchAgent): `npm run debug-server` en 127.0.0.1:4112, solo con la key dev.

Nada escucha fuera de loopback. El servidor Mastra no tiene auth; por eso la config rechaza cualquier host que no sea 127.0.0.1.

## 2. Configuración y secretos

Solo nombres y rutas. Los valores nunca van al repo ni al chat.

| Archivo (servidor) | Permisos | Llaves |
|---|---|---|
| `~/code/assistant-hub/.env` | 0600 | `GOOGLE_API_KEY`, `DEV_GOOGLE_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `MFP_MCP_URL`, `CINES_MCP_URL`, `FINANCE_MCP_URL`, `FINANCE_MCP_TOKEN`, `FINANCE_MCP_BYPASS`, `HEALTHCHECK_URL`, `MASTRA_TELEMETRY_DISABLED` |
| `~/.config/mfp-mason/mason.env` | 0600 | `MFP_USERNAME`, `MFP_LOGIN_EMAIL` |
| `~/.config/mfp-mason/alert.env` | 0600 | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| `~/.config/cines-mx/cines.env` | 0600 | `NODE_BIN`, `CINES_LOGIN_EMAIL`, `CINES_IMAP_USER`, `CINES_CODE_SENDER`, `CINES_BUYER_NAME` (opcionales: `CINES_CARD_LAST4`, `CINES_PAYPAL_WAIT_MIN`) |
| `~/.config/cines-mx/alert.env` | 0600 | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

**Keychain** (login del usuario `julian`):

| Item (`-s`) | Qué es | Lo usa |
|---|---|---|
| `mfp-login` | contraseña de MyFitnessPal (cuenta = `MFP_LOGIN_EMAIL`) | `bin/mfpctl login` y el re-login automático |
| `cines-mx-imap` | app password de Gmail del buzón del bot | lector IMAP de códigos de Cinépolis |
| `Chrome Safe Storage` | cifrado de cookies de Chrome | `bin/mfpctl login --manual` |

**Estado y sesiones** (todas las carpetas 0700):

- Hub: `~/Library/Application Support/assistant-hub/` → `mastra.db` (memoria, planes, aprobaciones pendientes, `llm_calls`, contador de compras), `debug/` (`debug-token` 0600).
- Mason: `~/Library/Application Support/myfitnesspal-mcp/` → `cookies.json` (0600), `browser-profile/`, `data.db`. Scripts del servicio en `~/Library/Application Support/mfp-mason/` (`bin/`, `login-venv/` con patchright, `relogin.last`).
- Cinépolis: `~/Library/Application Support/cines-mx/` → `app/` (copia desplegada), `browser-profile/` (sesión auth0 de Cinépolis + PayPal), `state/` (`holds.json`, `purchases.json`, `arm-pin.json` = hash scrypt, `apikey.cache`, `payment-arm.json` mientras está armado).
- Respaldos: iCloud Drive `assistant-hub-backups/` (`mastra-AAAAMMDD-HHMMSS.db`, 0600, guarda 7).
- Logs: `~/Library/Logs/assistant-hub/`, `~/Library/Logs/mfp-mason/`, `~/Library/Logs/cines-mx/`.

**En la laptop de trabajo** (no es el servidor): `~/code/assistant-hub/.env.server` (copia de los secretos de prod, 0600), `~/code/assistant-hub/.env` (bot dev + keys dev), `~/.config/finance-mcp/{prod,preview}.token` y `*-headers.txt`, y la llave SSH de `alfred-mac`.

El token del bot de Telegram vive en **tres** archivos: el `.env` del hub y los dos `alert.env`. Al rotarlo, cambia los tres.

## 3. Operación diaria

### Desplegar

**Hub** (en primer plano; si es por SSH, `ssh -t alfred-mac`):

```bash
cd ~/code/assistant-hub && scripts/deploy.sh
```

`deploy.sh` hace pull (solo fast-forward; se niega con cambios locales), `npm ci`, tests, build, y luego:

- Si el plist no cambió: `launchctl kickstart -k`. Si cambió: bootout, y espera a que launchd suelte la etiqueta (el bootout es asíncrono).
- bootstrap con hasta 5 intentos (cada 2 s); solo cuenta como hecho cuando `launchctl print` muestra la etiqueta. Si no, muere con el comando exacto para hacerlo a mano.
- `ensure_loaded` vuelve a registrar el hub y el backup si launchd los perdió.
- Espera `/health` 60 s; si no responde, imprime lo que ve launchd (estado, pid, último exit) y la cola del log.
- No lo lances desacoplado (`nohup`, `&`): así quedó la etiqueta sin registrar una vez.

**Mason:**

```bash
cd ~/code/mfp-weekly-sync && git pull --ff-only && scripts/install-mac.sh && bin/mfpctl install && bin/mfpctl restart
sleep 20 && bin/mfpctl status && bin/mfpctl health
```

**Cinépolis:**

```bash
cd ~/code/cines-mx-mcp && git pull --ff-only && npm ci && bin/cinesctl install
sleep 5 && bin/cinesctl status
```

`install` copia la app a Application Support, así que editar o mover el repo no afecta al servicio. El hub reconecta solo con un MCP que se reinició (cada minuto, y "Session not found" se reintenta una vez).

### Reiniciar

```bash
launchctl kickstart -k gui/$(id -u)/com.jdrami.assistant-hub
```

```bash
cd ~/code/mfp-weekly-sync && bin/mfpctl restart
```

```bash
cd ~/code/cines-mx-mcp && bin/cinesctl restart
```

### Estado

```bash
launchctl list | grep jdrami
curl -s http://127.0.0.1:4111/health
cd ~/code/mfp-weekly-sync && bin/mfpctl status && bin/mfpctl health
cd ~/code/cines-mx-mcp && bin/cinesctl status && bin/cinesctl session && bin/cinesctl hold-status
```

En Telegram (sin llamar al modelo): **`/estado`** (apps, Gemini hoy, 429s, presupuesto, últimas 3 fallas con su `req`, versión) y **`/usage`** (llamadas y tokens de hoy y 7 días).

### Logs

```bash
tail -F ~/Library/Logs/assistant-hub/hub.err.log ~/Library/Logs/assistant-hub/hub.out.log
```

```bash
tail -F ~/Library/Logs/mfp-mason/mason.err.log ~/Library/Logs/mfp-mason/mason.out.log ~/Library/Logs/mfp-mason/health.log
```

```bash
tail -F ~/Library/Logs/cines-mx/cines.err.log ~/Library/Logs/cines-mx/cines.out.log
```

Cada falla en Telegram trae `CODE · req 7f3a2c`. Para ver ese pedido completo:

```bash
grep 'req 7f3a2c' ~/Library/Logs/assistant-hub/hub.err.log
```

### Debug server (probar sin tocar el chat real)

```bash
cd ~/code/assistant-hub && npm run debug-server &
scripts/debug-chat.sh "¿qué hay en el Toreo hoy?"
```

Solo lectura salvo `--write`; las acciones con aprobación necesitan `--press "Aprobar"`; `cines_purchase` nunca. Key dev, 6 RPM, 8 llamadas por pedido, 80 por día. Usa su propio usuario y su propia carpeta.

## 4. Recuperación

### El Mac se reinició

1. Inicia sesión en el Mac a mano: los LaunchAgents solo arrancan con la sesión abierta (no hay auto-login).
2. Espera el 🔄 "De vuelta, Master Julian (versión …)" en Telegram.
3. Revisa:

```bash
launchctl list | grep jdrami
curl -s http://127.0.0.1:4111/health
cd ~/code/mfp-weekly-sync && bin/mfpctl status
cd ~/code/cines-mx-mcp && bin/cinesctl status && bin/cinesctl session
```

El primer apartado de Cinépolis después de un arranque abre Chrome unos 10 s (el token solo vive en memoria). Es normal.

### El hub no responde

```bash
launchctl print gui/$(id -u)/com.jdrami.assistant-hub | head -20
tail -50 ~/Library/Logs/assistant-hub/hub.err.log
launchctl kickstart -k gui/$(id -u)/com.jdrami.assistant-hub
```

Si `launchctl print` dice que la etiqueta no existe:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jdrami.assistant-hub.plist
```

O corre `scripts/deploy.sh` en primer plano, que la vuelve a registrar. Si el log muestra un crash en bucle, la versión anterior está en `git log`; nunca hagas `reset --hard` sin pensarlo.

### MFP: sesión vencida (🔴 `auth`, o `MFP_SESSION_EXPIRED` en el chat)

El health check ya intenta refresh y re-login solo. Si llega el 🔴, en este orden, frente al Mac:

1. Refresh:

```bash
cd ~/code/mfp-weekly-sync && bin/mfpctl refresh && bin/mfpctl health
```

2. Login con contraseña (Chrome real con patchright; solo toca la casilla de Cloudflare si aparece; "Permitir siempre" en el Keychain; **no cierres la ventana**):

```bash
cd ~/code/mfp-weekly-sync && bin/mfpctl login
```

3. Si Cloudflare sigue fallando, login a mano y luego ⌘Q en Chrome:

```bash
cd ~/code/mfp-weekly-sync && bin/mfpctl login --manual
```

4. Último recurso: copia la cabecera Cookie completa de una petición a myfitnesspal.com y:

```bash
cd ~/code/mfp-weekly-sync && pbpaste | bin/mfp-auth
```

Después: `sleep 20 && bin/mfpctl status && bin/mfpctl health`. Códigos de salida del login: 4 sin Keychain, 5 credenciales, 6 timeout/Turnstile, 7 inesperado, 8 falta patchright o Chrome. Detalle en `~/Library/Logs/mfp-mason/login.log`. Nunca uses "cerrar sesión en todos los dispositivos" en MFP: mata la sesión del bot.

### Cinépolis

| Síntoma | Qué hacer |
|---|---|
| `CINES_SESSION_EXPIRED`, o `bin/cinesctl session` no dice `valid` | `bin/cinesctl login` frente al Mac: correo + código de 6 dígitos (no Google). El código llega al buzón del bot; si no llega en ~150 s, Alfred lo pide en modo seguro. Comprueba con `bin/cinesctl mailbox-test`. |
| `CINES_BLOCKED` | Cloudflare bloquea esta red. Espera y prueba desde un navegador en la misma red. |
| Se abre una ventana de Chrome | Es el keepalive (cada 6 h) o el primer apartado tras un reinicio. Chrome tiene que ser visible (Cloudflare bloquea el modo headless). No la cierres. |
| `CINES_SCHEMA_CHANGED` / `API key not found` | Cinépolis cambió algo. Hay que actualizar cines-mx-mcp (hilo de Cinépolis). |
| health `fail:server` | Ver `bin/cinesctl status`; suele ser un health que corrió durante un reinicio. `bin/cinesctl health` lo vuelve a evaluar. |

### Gemini: cuota, 429, 503

- ⏸️ en el chat = un 429 real de Gemini. Los ⏳ son el pacer del hub (14 RPM flash-lite, 4 RPM 3.8-flash), no un error.
- 503 ("alta demanda"): el hub reintenta solo. Si dura, es Google; los mensajes van lentos ("Sigo en ello; Gemini está lento…").
- Cuota diaria agotada (free tier): no hay nada que reiniciar. Se libera cuando Google reinicia la cuota diaria. `/estado` muestra las llamadas de hoy y los 429.
- Salida definitiva: cargar crédito prepago (≈ $5 USD) en el proyecto `PersonalAssistant`. Misma key, sin cambiar nada en el Mac.
- 💸 "Pausado, presupuesto": tope propio del hub (`DAILY_TOKEN_CAP`, `DAILY_COST_CAP_USD`); se reinicia a medianoche de Bogotá.
- Nunca uses la key de prod para replay, tests o debug: comparten cuota con el bot (así se cayó Alfred el 2026-10-19).

### Estados de un pago

| Estado | Significado | Qué hacer |
|---|---|---|
| ✅ `paid` | cobrado, con número de reserva | nada; llega el correo |
| ❌ `failed` / `CINES_PAYMENT_FAILED` | no se cobró; asientos liberados | volver a empezar con otro apartado |
| ⚠️ `unknown` / "incierto" | no se sabe si cobró; los asientos **no** se liberan | revisar correo de Cinépolis y el banco. Nunca reintentar. |
| 🔒 "no está armado" | no se registró nada | armar (PIN o `arm-payment`) y volver a tocar Comprar |
| ❌ 3-D Secure | el banco pidió verificación extra; no se cobró | PayPal (en el Mac) o la app de Cinépolis |

```bash
cd ~/code/cines-mx-mcp && bin/cinesctl hold-status
```

Liberar asientos a mano (solo si ya confirmaste que **no** hubo cobro) y desarmar:

```bash
cd ~/code/cines-mx-mcp && bin/cinesctl release-hold && bin/cinesctl disarm-payment
```

Un apartado sin pagar expira solo en ~9 min.

### PIN de compras bloqueado

Tres PIN incorrectos seguidos desactivan el armado por PIN (no se cobra nada y el apartado sigue). Configura uno nuevo en una terminal real (en el Mac o `ssh -t alfred-mac`):

```bash
cd ~/code/cines-mx-mcp && bin/cinesctl set-arm-pin
```

Alternativa para una sola compra: `bin/cinesctl arm-payment` (escribir `ARMAR`, 30 min, un intento).

### healthchecks.io en rojo

Significa que el hub dejó de hacer ping hace más de 15 min: el Mac durmió, se apagó, perdió red, o el hub está caído o en bucle.

1. Desde la laptop: `ssh alfred-mac`. Si no conecta: revisar el Mac en persona (corriente, red, pantalla de login tras un reinicio).
2. Si conecta: seguir "El hub no responde".
3. Un ping a `/fail` (en vez de silencio) es que falló el chequeo de la base de datos: revisa `hub.err.log` y el espacio en disco (`df -h /`).

## 5. Rotar secretos

| Secreto | Dónde se genera | Dónde actualizarlo | Reiniciar |
|---|---|---|---|
| Token del bot prod | @BotFather → `/revoke` → `/token` | `assistant-hub/.env`, `~/.config/mfp-mason/alert.env`, `~/.config/cines-mx/alert.env` (y `.env.server` de la laptop) | hub (`kickstart`); los health leen el archivo en cada corrida |
| Gemini prod (`GOOGLE_API_KEY`) | AI Studio, proyecto `PersonalAssistant`: crear key nueva, borrar la vieja | `assistant-hub/.env` (y `.env.server`; quitarla del `.env` de la laptop) | hub |
| Finance MCP token | Vercel → finance-app-backend → env `MCP_TOKEN`; redeploy | `FINANCE_MCP_TOKEN` en `assistant-hub/.env`, `~/.config/finance-mcp/prod.token` y `prod-headers.txt` de la laptop | hub |
| Vercel bypass | Vercel → finance-app-backend → Settings → Deployment Protection → Protection Bypass for Automation | `FINANCE_MCP_BYPASS` solo en el `.env` de dev (en prod debe quedar vacío) | hub dev |
| Contraseña MFP | myfitnesspal.com | `security add-generic-password -U -s mfp-login -a <correo> -w` en el Mac | `bin/mfpctl login` |
| Sesión MFP (cookie) | — | `bin/mfpctl login` (o `pbpaste \| bin/mfp-auth`) | lo hace el login |
| App password del buzón del bot | Google Account del bot → App passwords | `security add-generic-password -U -s cines-mx-imap -a <buzón> -w` | `bin/cinesctl restart` |
| Sesión Cinépolis / PayPal | — | `bin/cinesctl login` / `bin/cinesctl paypal-login` | `bin/cinesctl restart` |
| PIN de compras | — | `bin/cinesctl set-arm-pin` | — |
| healthchecks.io URL | healthchecks.io → check → regenerar | `HEALTHCHECK_URL` en `assistant-hub/.env` | hub |

**Expuestos en el chat y pendientes de rotar** (al 2026-10-20 los valores del servidor siguen siendo los de `.env.server`, el archivo que se pegó):

- [ ] Token del bot prod.
- [ ] Gemini prod (además está en el `.env` de la laptop).
- [ ] Finance MCP token.
- [ ] Vercel bypass (lo creó `vercel curl`; además hoy está en el `.env` de prod).
- [ ] URL de healthchecks.io (riesgo bajo: alguien podría marcarlo en verde o rojo).
- Cookie MFP pegada el 2026-10-19: ya reemplazada por sesiones nuevas; no reusar.

Nunca se pegaron: CVV, PIN de compras, contraseña de MFP ni la app password del buzón.

## 6. Decisiones

| Fecha | Decisión | Por qué |
|---|---|---|
| 2026-10-18 | **Telegram**, no WhatsApp | API de bots gratis, long polling sin abrir puertos, canal oficial de Mastra con botones de aprobación. |
| 2026-10-18 | **Mastra** (TypeScript), no n8n | 1.0 estable, Telegram + aprobaciones + cron incluidos, mismo toolchain Node. La lógica vive en los MCP, así que cambiar de framework solo reescribe el hub. |
| 2026-10-18 | Un repo por pieza; el hub es repo nuevo | Hub en el Mac, finanzas en Vercel, Mason y Cinépolis como MCP locales. Agregar una app = una entrada en `mcp-servers.json`. |
| 2026-10-18 | **Escrituras inteligentes** | Lecturas y altas corren directo; borrados y cambios destructivos piden ✅. |
| 2026-10-18 | **Una sola familia: Gemini** | Una key y una factura. `gemini-3.5-flash-lite` por defecto (texto, fotos, voz); `gemini-3.8-flash` para el resumen semanal y como reintento cuando flash-lite devuelve una llamada de herramienta malformada. Nunca se escala por un 429. |
| 2026-10-19 | **Free tier por ahora; pagar cuando se quede corto** | Primero optimizar (−37 % llamadas, −61 % tokens en el replay). Contra: en free tier Google puede usar los mensajes para entrenar. Prepago ≈ $5 cuando haga falta (2026-10-20). |
| 2026-10-19 | **Keys de Gemini separadas prod/dev** | El replay agotó la cuota del bot. Tests, replay, bot dev y debug server usan `AssistantDev`; el código rechaza la key de prod. |
| 2026-10-19 | **Zona horaria America/Bogota** | Aunque el usuario vive en CDMX; todo (días, presupuesto, comidas por hora) usa Bogotá. |
| 2026-10-19 | **Persona Alfred** (Pennyworth) | Formal, humor seco, una línea y luego los hechos. `HUB_PERSONA=plain` lo apaga. El 2026-10-20 pasó de "Amo Julián" a **"Master Julian"** en ambos idiomas (`60afba7`). |
| 2026-10-19 | **Aprobación por lote (`propose_plan`)** | Borrar un día pedía 17 aprobaciones. Ahora: una tarjeta con Aprobar todo / Editar / Cancelar; el hub ejecuta exactamente lo aprobado (huella del plan). |
| 2026-10-19 | **Guardia de 800 kcal** | Una entrada > 800 kcal siempre pide ✅ (caso "2 de X" = 1,700 kcal). Más el chequeo 2× contra la estimación en `log_meal`. |
| 2026-10-19 | **Una sola máquina tiene la sesión MFP** | Dos copias de Mason se pisan la cookie. Windows retirado; Mason corre una vez en HTTP y todos se conectan ahí. |
| 2026-10-20 | **`clear_day` en el hub** | El hub arma los borrados desde el diario (no el modelo) y muestra una tarjeta compacta; evita planes incompletos y reasoning en el chat. |
| 2026-10-20 | **Mason fijado a upstream `640e79f`** hasta 0.4.2 | Arregla borrar uno de dos duplicados idénticos. Sin fork. Volver a PyPI `==0.4.2` cuando salga. |
| 2026-10-20 | **Login MFP con contraseña vía patchright + Chrome instalado** | La cookie compartida con el navegador caducaba; el Chromium de Playwright no pasaba Turnstile. Contraseña en Keychain; `--manual` y la cookie quedan de respaldo. |
| 2026-10-20 | **Acceso SSH solo con llave** desde la laptop | Los agentes despliegan y revisan logs sin que el usuario copie comandos. |
| 2026-10-20 | **Cinépolis: tarjeta guardada por defecto**, PayPal de respaldo | Con tarjeta no hay que estar en el Mac (solo CVV por chat). PayPal necesita aprobar en la pantalla del Mac. Varias tarjetas: la "Predeterminada" salvo que el usuario nombre otra. |
| 2026-10-20 | **Armado del pago**: `arm-payment` (un intento, en el Mac) o **PIN de compras** desde Telegram | Un flag de entorno podía quedarse encendido para siempre. El PIN (6–8 dígitos, hash scrypt) arma una sola compra ligada a ese apartado y total, 10 min; 3 errores lo desactivan. |
| 2026-10-20 | **Tope de $1,000 MXN** por compra | Lo eligió el usuario. Se valida contra el total del apartado que vio el hub, nunca contra el número del modelo; el servidor lo valida también. |
| 2026-10-20 | **Las primeras 3 compras piden ✅** | Después, aprobar el apartado cubre la compra (si está bajo el tope y el servidor no pide aprobación). |
| 2026-10-20 | **Nunca reintentar un pago** | Cada apartado se paga a lo más una vez. Un resultado incierto no se reintenta ni libera los asientos. |
| 2026-10-20 | **CVV y PIN nunca llegan al modelo** | Entrada segura: el hub toma el siguiente mensaje, lo borra del chat, valida el formato y lo manda directo a `cines_submit_code`. No va a memoria, logs ni `llm_calls`. |
| 2026-10-20 | **3-D Secure rechazado por ahora** | Se rechaza antes de cobrar; usar PayPal o la app. Nunca se ha visto en la práctica. |
| 2026-10-20 | Chrome visible para Cinépolis; token solo en memoria | Cloudflare bloquea headless. Guardar el token en disco sería guardar un secreto; a cambio, el primer apartado tras reiniciar abre Chrome ~10 s. |
| 2026-10-20 | Un asiento suelto es solo advertencia | Cinépolis MX sí lo permite (la regla venía de Argentina). |
| 2026-10-20 | **Mantener el Mac Intel por ahora** | Funciona y la carga es baja. El costo está en instalar (compila desde cero). Más adelante: Mac mini Apple Silicon. |

## 7. Pendientes y siguientes pasos

**Fase 1: estabilidad y visibilidad**

- [x] 1.1 healthchecks.io configurado.
- [ ] 1.2 Medición de velocidad: tiempo por tramo (pacer, Gemini, herramientas, Telegram), p50/p95 en `/estado`, top 5 lento (hilo 9).
- [x] 1.3 Este runbook.
- [ ] 1.4 MFP: un `bin/mfpctl login` frente al Mac sin tocar la ventana, luego vigilar 48 h que la sesión aguante y que `refresh` rote el token (hoy dice `rotated: no` desde la madrugada del 2026-10-20).

**Fase 2: calidad**

- Comidas propositivas por voz y texto: porción estándar en vez de preguntar, platos típicos desarmados en código, comidas frecuentes, revisión de sentido común. Sin más tokens.
- Pulir errores en vivo, uno por tipo.
- Replay completo (~40 escenarios, key dev) y tests inestables (el de "tampered plan", y los que dependen del reloj).

**Fase 3: resúmenes**

- Resumen semanal del domingo: finanzas, comida, cine y 1–3 sugerencias.
- Cartelera del miércoles: estrenos y preventas en Toreo, Miyana y Carso, subtitulados primero.

**Fase 4:** plan de comidas semanal con el prompt de ChatGPT del usuario, cargado a MFP con las reglas de conciliación, más la lista de compras.

**Sin fecha**

- Rotar los secretos expuestos (sección 5).
- Pagar Gemini cuando se quede corto.
- MCPs nuevos: calendario, recibos desde el Gmail del bot, Walmart/Rappi, transporte, recordatorios.
- Cinépolis v3: favoritos ("lo de siempre"), avisos de preventa, dulcería y cupones de Sam's, Cinemex, varias personas.
- Volver a Mason PyPI cuando salga 0.4.2.
- Finanzas en ChatGPT con OAuth.
- Home server / home lab; Apple Silicon.

## 8. Inconsistencias vistas el 2026-10-20

- **Energía:** `pmset` muestra `SleepDisabled 1`, pero `sleep 1`, `disksleep 10` y sin `autorestart`. `setup-mac.sh` propone `sleep 0 disksleep 0 autorestart 1`. Sin `autorestart`, el Mac no vuelve solo tras un corte de luz.
- **Actualizaciones de macOS:** la instalación automática está **encendida**; el README recomienda apagarla (un reinicio nocturno deja el bot en la pantalla de login).
- **FileVault apagado y sin auto-login:** tienes la desventaja de las dos opciones (disco sin cifrar y aun así login manual tras reiniciar). Elige una.
- **`FINANCE_MCP_BYPASS` en el `.env` de prod:** `.env.example` dice dejarlo vacío en prod.
- **Node distinto:** el hub corre con `/usr/local/opt/node@24`, Cinépolis con `/usr/local/bin/node`.
- **IP:** el SSH apunta a `192.168.1.90` y el día de la instalación el Mac tenía `.89`. Conviene una reserva DHCP en el router.
- **`cines-health`:** último resultado `fail:server` (exit 1), aunque el servidor responde 200; probablemente corrió durante un reinicio.
- **Login MFP:** no existe `login-profile`: la sesión actual viene del cookie paste, no de `mfpctl login` (pendiente 1.4).
- **Docs desactualizados:** el README del hub dice "paid tier" y "real payment disabled until the live PayPal check" (ya hubo compra real con tarjeta); el runbook de Mason dice que el hub solo conecta al arrancar y que el token del bot está en dos lugares (son tres); el de Cinépolis espera "8 tools" (son 13).
- **Escritorio del Mac:** quedaron 10 archivos `*.txt` de instrucciones (`mfp-cookie.txt`, `pin-compras.txt`…). Bórralos si ya no los usas.
