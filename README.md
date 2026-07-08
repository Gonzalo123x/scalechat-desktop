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

Los instaladores se generan en `dist/` con **electron-builder**.

```bash
npm install         # incluye electron-updater
npm run dist        # instalador para el SO actual
npm run dist:win    # Windows (.exe NSIS)
npm run dist:mac    # macOS (.dmg)
npm run dist:linux  # Linux (AppImage)
```

> Cada SO se compila en su propia plataforma (Windows en Windows, macOS en Mac).
> Para las 3 a la vez sin tener las 3 máquinas, usa el CI (abajo).

### Ícono de marca
Exporta `build/icon.svg` a **`build/icon.png` (1024×1024)**. electron-builder
genera solo el `.ico` (Windows) y `.icns` (macOS) a partir de ese PNG. Sin él,
usa el ícono por defecto de Electron.

### Firma de código (evita el aviso “app no verificada”)
- **Windows**: consigue un certificado de firma de código (OV/EV). Exporta:
  `CSC_LINK` (ruta o base64 del .pfx) y `CSC_KEY_PASSWORD`.
- **macOS**: requiere cuenta de Apple Developer. Exporta `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` y `APPLE_TEAM_ID` (electron-builder notariza solo).
- Sin firmar igual funciona para pruebas, pero el SO mostrará una advertencia.

### Auto-actualización (electron-updater)
La app busca versiones nuevas en **GitHub Releases** al abrir (solo empaquetada),
las descarga y las instala al reiniciar. Para publicar una versión:

1. Sube este repo a GitHub como **Gonzalo123x/scalechat-desktop** (privado o público).
2. Sube el certificado/credenciales como *secrets* del repo (ver `.github/workflows/build.yml`).
3. Sube la versión en `package.json` (p. ej. `0.1.1`), haz commit y crea un tag:
   ```bash
   git tag v0.1.1 && git push --tags
   ```
4. El workflow compila Win/Mac/Linux y publica el release. Los usuarios se
   actualizan solos la próxima vez que abran la app.

> ¿Prefieres no usar GitHub? Cambia `build.publish` a `{"provider":"generic","url":"https://TU-CDN/updates/"}`
> (p. ej. tu bucket de R2) y sube ahí el contenido de `dist/` (incluido `latest.yml`).

## Notas

- **Sin proxy** para 1–3 números en una conexión de casa. Para muchos números en
  una sola conexión conviene 1 IP por número (proxy por número) o Cloud API.
- La PC debe estar **encendida y con internet** para que el bot responda.
- Solo **1:1**: ignora grupos y estados.
- Pendiente (siguientes fases): botón en Canales que entregue el token (Fase 2),
  envío del agente desde la bandeja web (Fase 3), bandeja del sistema + auto-update
  + firma de código (Fase 4).
