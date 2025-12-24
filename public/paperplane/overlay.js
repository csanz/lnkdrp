(() => {
  const statusEl = document.getElementById("status");
  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };
  console.log("[paperplane] overlay.js loaded");
  setStatus("Overlay loaded.");

  const getStarted = document.getElementById("ctaGetStarted");
  const login = document.getElementById("navLogin");

  const modal = document.getElementById("inviteModal");
  const closeBtn = document.getElementById("inviteClose");
  const input = document.getElementById("inviteInput");
  const continueBtn = document.getElementById("inviteContinue");
  const msg = document.getElementById("inviteModalMsg");
  if (!modal || !closeBtn || !input || !continueBtn || !msg) {
    console.error("[paperplane] overlay.js missing elements", {
      modal: !!modal,
      closeBtn: !!closeBtn,
      input: !!input,
      continueBtn: !!continueBtn,
      msg: !!msg,
    });
    setStatus("Overlay error: missing modal elements (see console).");
    return;
  }

  let inviteOk = false;
  let pendingHref = "/client-upload";

  function setMsg(text, kind) {
    msg.textContent = text || "";
    msg.classList.remove("error", "ok");
    if (kind) msg.classList.add(kind);
  }

  function openModal(nextHref) {
    pendingHref = typeof nextHref === "string" ? nextHref : "/client-upload";
    modal.setAttribute("data-open", "true");
    setMsg("", "");
    setTimeout(() => input.focus(), 0);
  }

  function closeModal() {
    modal.setAttribute("data-open", "false");
    setMsg("", "");
  }

  async function verify(code) {
    const trimmed = (code || "").trim();
    // If already invited (cookie set), allow continuing without re-entering a code.
    if (!trimmed) {
      await refreshInviteStatus();
      if (inviteOk) {
        window.location.href = pendingHref || "/client-upload";
        return;
      }
      setMsg("Enter an invite code.", "error");
      return;
    }
    continueBtn.disabled = true;
    continueBtn.textContent = "Checking…";
    setMsg("", "");
    try {
      const res = await fetch("/api/invites/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(typeof data.error === "string" ? data.error : "Invalid invite code.", "error");
        return;
      }
      setMsg("Invite accepted. Redirecting…", "ok");
      inviteOk = true;
      window.location.href = pendingHref || "/client-upload";
    } catch {
      setMsg("Couldn’t verify invite code. Try again.", "error");
    } finally {
      continueBtn.disabled = false;
      continueBtn.textContent = "Continue";
    }
  }

  continueBtn.addEventListener("click", () => verify(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") verify(input.value);
  });

  closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  async function refreshInviteStatus() {
    try {
      const res = await fetch("/api/invites/status", { method: "GET" });
      const data = await res.json().catch(() => ({}));
      inviteOk = data && data.ok === true;
    } catch {
      inviteOk = false;
    }
  }
  refreshInviteStatus();

  function intercept(el, href) {
    if (!el) return;
    // Always open the modal (even if already invited) so the UX is consistent.
    el.addEventListener("click", async () => {
      await refreshInviteStatus();
      openModal(href);
      if (inviteOk) setMsg("Invite already accepted. Continue to proceed.", "ok");
    });
  }
  intercept(getStarted, "/client-upload");
  intercept(login, "/login");

  // Fallback: event delegation (in case direct handlers didn't bind for any reason).
  document.addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("#ctaGetStarted")) {
      await refreshInviteStatus();
      openModal("/client-upload");
      if (inviteOk) setMsg("Invite already accepted. Continue to proceed.", "ok");
    }
    if (t.closest("#navLogin")) {
      await refreshInviteStatus();
      openModal("/login");
      if (inviteOk) setMsg("Invite already accepted. Continue to proceed.", "ok");
    }
  });

  // Auto-claim from email link: /?invite=CODE
  try {
    const url = new URL(window.location.href);
    const code = (url.searchParams.get("invite") || "").trim();
    if (code) {
      openModal("/client-upload");
      input.value = code;
      verify(code);
      url.searchParams.delete("invite");
      window.history.replaceState(null, "", url.toString());
    }
  } catch {
    // ignore
  }
})();


