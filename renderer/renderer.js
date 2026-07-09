// UI de Scalechat Desktop: lista de números, QR y registro.
const $ = (id) => document.getElementById(id);
const STATUS_LABEL = {
  CONNECTED: "Conectado",
  CONNECTING: "Conectando…",
  QR_PENDING: "Escanea el QR",
  DISCONNECTED: "Desconectado",
  ERROR: "Error",
};

function render(list) {
  const box = $("profiles");
  if (!list || list.length === 0) {
    box.innerHTML = '<div class="empty">Aún no añadiste ningún número.</div>';
    return;
  }
  box.innerHTML = "";
  for (const p of list) {
    const el = document.createElement("div");
    el.className = "profile";
    const meta = p.phone ? `+${p.phone}` : p.lastError || STATUS_LABEL[p.status] || "";
    el.innerHTML = `
      <span class="dot ${p.status}"></span>
      <div class="grow">
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="pmeta">${STATUS_LABEL[p.status] || p.status} · ${escapeHtml(meta)}</div>
        ${
          p.status === "QR_PENDING" && p.qr
            ? `<div class="qr"><img src="${p.qr}" alt="QR" /><p>Abre WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p></div>
        <div class="tips warn">
          <div class="tips-title">⚡ Escanéalo rápido: el QR se renueva cada ~20 segundos.</div>
          <ul>
            <li>Si no conecta, revisa <b>WhatsApp → Dispositivos vinculados</b> y borra los viejos (máx. 4).</li>
            <li>Si sigue sin vincular (código 400), ese número puede estar <b>restringido por WhatsApp</b>. Prueba con otro número con antigüedad/uso real.</li>
          </ul>
        </div>`
            : ""
        }
      </div>
      <button class="ghost" data-reconnect="${p.id}">Reconectar</button>
      <button class="ghost" data-remove="${p.id}">Quitar</button>
    `;
    box.appendChild(el);
  }
  box.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (confirm("¿Quitar este número? Se cerrará su sesión en esta PC.")) {
        await window.api.removeProfile(b.dataset.remove);
      }
    }),
  );
  box.querySelectorAll("[data-reconnect]").forEach((b) =>
    b.addEventListener("click", () => window.api.reconnect(b.dataset.reconnect)),
  );
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

$("add").addEventListener("click", async () => {
  $("err").textContent = "";
  $("add").disabled = true;
  const res = await window.api.addProfile({
    name: $("name").value,
    apiUrl: $("apiUrl").value,
    token: $("token").value,
  });
  $("add").disabled = false;
  if (res?.error) {
    $("err").textContent = res.error;
    return;
  }
  $("name").value = "";
  $("token").value = "";
});

window.api.onState((list) => render(list));
window.api.onLog((line) => {
  const log = $("log");
  log.textContent += line + "\n";
  log.scrollTop = log.scrollHeight;
});

// Carga inicial.
window.api.listProfiles().then(render);
