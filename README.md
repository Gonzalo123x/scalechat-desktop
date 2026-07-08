# Scalechat Desktop

Conector de escritorio de **Scalechat**. Conecta uno o varios números de WhatsApp
**por QR** desde la PC del usuario (Baileys) — así **sale por la IP residencial del
usuario, sin proxy** — y responde con **los mismos flujos, IA y comprobantes** que
ya tienes configurados en la web de Scalechat.

Es solo el **transporte**: toda la lógica vive en Scalechat. La app recibe el
mensaje, lo manda a `/api/desktop/inbound`, y ejecuta las acciones que Scalechat
devuelve (typing, texto, imagen/vídeo/documento).

> Repo **independiente** del backend de Scalechat (no se despliega en Railway).

## Cómo funciona

```
WhatsApp del cliente ─▶ Baileys (esta app, en la PC del usuario)
        │ mensaje entrante
        ▼
POST {SCALECHAT}/api/desktop/inbound   (Authorization: Bearer <deviceToken>)
        │ { actions: [ typing, text, media… ] }
        ▼
La app envía las acciones por WhatsApp (con los tiempos del flujo)
```

La sesión de cada número se guarda en el disco del usuario
(`userData/sessions/<id>`), así que **no re-escanea el QR** al reabrir.

## Requisitos

- Node.js 18+ y npm.
- Un **token de dispositivo** por número (se genera en Scalechat → Canales →
  “Conectar desde la app de escritorio”). Ese token identifica el canal `QR_DESKTOP`.

## Desarrollo

```bash
npm install
npm start
```

En la ventana:
1. **Añadir un número** → nombre + URL de Scalechat (`https://dash.scalechat.app`) + el **token**.
2. Aparece el **QR** → escanéalo con el WhatsApp del número (Dispositivos vinculados).
3. Cuando diga **Conectado**, el bot ya responde 1:1 con tus flujos de Scalechat.

## Empaquetar instaladores (Fase 4)

```bash
npm run dist        # SO actual
npm run dist:win    # Windows (.exe NSIS)
npm run dist:mac    # macOS (.dmg)  — requiere firmar/notarizar para evitar avisos
```

## Notas

- **Sin proxy** para 1–3 números en una conexión de casa. Para muchos números en
  una sola conexión conviene 1 IP por número (proxy por número) o Cloud API.
- La PC debe estar **encendida y con internet** para que el bot responda.
- Solo **1:1**: ignora grupos y estados.
- Pendiente (siguientes fases): botón en Canales que entregue el token (Fase 2),
  envío del agente desde la bandeja web (Fase 3), bandeja del sistema + auto-update
  + firma de código (Fase 4).
