(() => {
  const statusEl = document.getElementById("status");
  const statusTextEl = document.getElementById("statusText");
  const setStatus = (msg) => {
    if (statusTextEl) statusTextEl.textContent = msg;
    // Fallback (older markup): statusEl was just a text node.
    else if (statusEl) statusEl.textContent = msg;
  };

  console.log("[paperplane] boot.js loaded");
  setStatus("Booting…");

  const mainUrl = new URL("./main.js", window.location.href).toString();
  import(mainUrl)
    .then(() => {
      console.log("[paperplane] main.js imported");
    })
    .catch((err) => {
      console.error("[paperplane] failed to import main.js:", err);
      setStatus(`Failed to start (see console): ${err?.message || err}`);
    });
})();




