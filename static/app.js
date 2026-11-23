const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Abhaken: kurzer Puls in der Zeile, dann rutscht sie nach ganz unten und
// die Zeilen darunter rücken nacheinander nach oben (FLIP), danach speichern.
async function completeRow(box) {
  const form = box.form;
  const li = box.closest("li");
  const ul = li?.parentElement;
  if (form.dataset.busy) return;
  form.dataset.busy = "1";
  try {
    navigator.vibrate?.(15);
    li.classList.add("completing");
    await wait(260);
    const rows = [...ul.children].filter((el) => !el.hidden);
    const before = new Map(
      rows.map((el) => [el, el.getBoundingClientRect().top]),
    );
    ul.append(li);
    const anims = [];
    let n = 0;
    for (const el of rows) {
      const dy = before.get(el) - el.getBoundingClientRect().top;
      if (!dy) continue;
      const moving = el === li;
      anims.push(el.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
        {
          duration: moving ? 420 : 240,
          delay: moving ? 0 : n++ * 40,
          easing: moving ? "cubic-bezier(.3,.7,.2,1)" : "ease-out",
          fill: "backwards",
        },
      ));
    }
    await Promise.all(anims.map((a) => a.finished));
  } finally {
    form.requestSubmit();
  }
}

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.matches(".check input") && el.checked && !reducedMotion()) {
    completeRow(el);
    return;
  }
  if (el.matches("[data-autosubmit]")) {
    el.form.requestSubmit();
    return;
  }
  // Blocker-Feld nur zeigen (und verlangen), wenn die Liste "Blocker" ist.
  if (el.matches("input[name=list]") && el.form) {
    const field = el.form.querySelector(".blocker-field");
    if (!field) return;
    const on = el.value === "blocker";
    field.hidden = !on;
    field.querySelector("input").required = on;
  }
  // Serien: Wochentage oder Monatstage je nach Rhythmus.
  if (el.matches("input[name=kind]") && el.form) {
    for (const k of ["weekly", "monthly"]) {
      el.form.querySelector(`.kind-${k}`).hidden = el.value !== k;
    }
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Suche: filtert die Zeilen im Browser (Text, Beschreibung, Blocker).
document.addEventListener("input", (e) => {
  const input = e.target;
  if (!input.matches("[data-search]")) return;
  const q = input.value.trim().toLowerCase();
  const ul = document.querySelector(".tasks");
  let hits = 0;
  if (ul) {
    for (const li of ul.children) {
      li.hidden = !!q && !li.dataset.q.includes(q);
      if (!li.hidden) hits++;
    }
    ul.classList.toggle("filtering", !!q);
  }
  const none = document.querySelector(".nomatch");
  if (none) none.hidden = !q || hits > 0 || !ul;
});

// Drag and drop (Maus und Touch) am Griff; Reihenfolge wird gespeichert.
let drag = null;
const order = (ul) => [...ul.children].map((li) => li.dataset.id);
document.addEventListener("pointerdown", (e) => {
  const grip = e.target.closest?.(".grip");
  if (!grip || e.button > 0) return;
  const li = grip.closest("li");
  const ul = li.parentElement;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  li.classList.add("dragging");
  drag = { li, ul, start: order(ul).join() };
});
document.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const { li, ul } = drag;
  const y = e.clientY;
  if (y < 80) scrollBy(0, -12);
  else if (y > innerHeight - 140) scrollBy(0, 12);
  for (const sib of ul.children) {
    if (sib === li || sib.hidden) continue;
    const r = sib.getBoundingClientRect();
    if (y < r.top || y > r.bottom) continue;
    const mid = r.top + r.height / 2;
    const after = li.compareDocumentPosition(sib) &
      Node.DOCUMENT_POSITION_FOLLOWING;
    if (after && y > mid) sib.after(li);
    else if (!after && y < mid) sib.before(li);
    break;
  }
});
const endDrag = (e) => {
  if (!drag) return;
  const { li, ul, start } = drag;
  drag = null;
  li.classList.remove("dragging");
  if (e.type === "pointercancel" || order(ul).join() === start) return;
  fetch(ul.dataset.reorder, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: order(ul) }),
  }).then((res) => {
    if (!res.ok) throw new Error(res.statusText);
  }).catch(() => location.reload());
};
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

// Eigene Dropdowns (.dd): Button öffnet eine Liste, Wert steckt im Hidden-Input.
const setOpen = (dd, open) => {
  dd.classList.toggle("open", open);
  dd.querySelector(".dd-list").hidden = !open;
  dd.querySelector(".dd-btn").setAttribute("aria-expanded", String(open));
  if (open) dd.querySelector("[aria-selected=true], [role=option]").focus();
};
const choose = (dd, opt) => {
  const input = dd.querySelector("input");
  const changed = input.value !== opt.dataset.value;
  for (const o of dd.querySelectorAll("[role=option]")) {
    o.setAttribute("aria-selected", String(o === opt));
  }
  dd.querySelector(".dd-label").textContent = opt.textContent;
  setOpen(dd, false);
  dd.querySelector(".dd-btn").focus();
  if (changed) {
    input.value = opt.dataset.value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
};
document.addEventListener("click", (e) => {
  const dd = e.target.closest?.(".dd");
  for (const o of document.querySelectorAll(".dd.open")) {
    if (o !== dd) setOpen(o, false);
  }
  if (!dd) return;
  const opt = e.target.closest("[role=option]");
  if (opt) choose(dd, opt);
  else if (e.target.closest(".dd-btn")) {
    setOpen(dd, !dd.classList.contains("open"));
  }
});
document.addEventListener("keydown", (e) => {
  const dd = e.target.closest?.(".dd");
  if (!dd) return;
  const btn = dd.querySelector(".dd-btn");
  const open = dd.classList.contains("open");
  if (e.target === btn) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setOpen(dd, true);
    }
    return;
  }
  const opts = [...dd.querySelectorAll("[role=option]")];
  const i = opts.indexOf(e.target);
  const go = (n) => {
    e.preventDefault();
    opts[(n + opts.length) % opts.length].focus();
  };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(opts.length - 1);
  else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    choose(dd, e.target);
  } else if (e.key === "Escape") {
    e.preventDefault();
    setOpen(dd, false);
    btn.focus();
  } else if (e.key === "Tab") setOpen(dd, false);
});
