// Login page: posts the password and code, then goes to the app. Talks to the server directly
// because the shim (and its 401 redirect) only loads after signing in.
(() => {
  const $ = id => document.getElementById(id);
  const show = msg => { $("err").textContent = msg; $("err").hidden = !msg; };

  // Already signed in (for example, a second tab): go straight to the app.
  fetch("/api/sesion").then(r => { if (r.ok) location.replace("/"); }, () => {});

  let lockTimer;
  function lockFor(seconds) {
    clearInterval(lockTimer);
    const until = Date.now() + seconds * 1000;
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) { clearInterval(lockTimer); $("go").disabled = false; show(""); return; }
      const m = Math.floor(left / 60), s = String(left % 60).padStart(2, "0");
      show(`Demasiados intentos. Espera ${m}:${s} para volver a intentarlo.`);
    };
    $("go").disabled = true;
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  $("form").addEventListener("submit", async e => {
    e.preventDefault();
    const password = $("password").value, codigo = $("codigo").value.trim();
    if (!password || !codigo) return show("Escribe la contraseña y el código.");
    $("go").disabled = true;
    show("");
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, codigo }),
      });
      if (r.ok) return location.replace("/");
      if (r.status === 429) return lockFor(Number(r.headers.get("Retry-After")) || 30);
      show(r.status === 401 ? "Contraseña o código incorrectos." : "No se pudo iniciar sesión. Inténtalo de nuevo.");
      $("codigo").value = "";
      $("codigo").focus();
    } catch {
      show("No se pudo conectar con el servidor. Revisa tu conexión.");
    }
    $("go").disabled = false;
  });
})();
