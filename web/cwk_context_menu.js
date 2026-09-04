/**
 * CWK Preset Manager — Context menu, image picker, version checker.
 *
 * Exports
 * ───────
 *   isVideoUrl(url)
 *   fmtSize(kb)
 *   closeContextMenu()
 *   showContextMenu(x, y, items)
 *   showImagePicker(modelName, images, onPick)
 *   showVersionChecker(modelName, apiKey, onDownloadDone)
 */

// ─── Utilities ────────────────────────────────────────────────────────────────

export function isVideoUrl(url) {
  if (!url) return false;
  try {
    const p = new URL(url).pathname.toLowerCase();
    return p.endsWith(".mp4") || p.endsWith(".webm");
  } catch {
    const l = url.toLowerCase();
    return l.includes(".mp4") || l.includes(".webm");
  }
}

export function fmtSize(kb) {
  if (!kb) return "";
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb > 1024)        return `${(kb / 1024).toFixed(1)} MB`;
  return `${Math.round(kb)} KB`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _overlay() {
  const el = document.createElement("div");
  el.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,.75);
    z-index:99998; display:flex; align-items:center; justify-content:center;
  `;
  return el;
}

// ─── Context menu ─────────────────────────────────────────────────────────────

let _activeMenu = null;

export function closeContextMenu() {
  if (_activeMenu) { _activeMenu.remove(); _activeMenu = null; }
}

export function showContextMenu(x, y, items) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.style.cssText = `
    position:fixed; left:${x}px; top:${y}px; z-index:99999;
    background:#1a2035; border:1px solid #313552; border-radius:8px;
    padding:4px 0; min-width:224px;
    box-shadow:0 8px 32px rgba(0,0,0,.65);
    font-family:Inter,system-ui,sans-serif; font-size:13px; color:#cdd6f4;
  `;

  for (const item of items) {
    if (item === "---") {
      const sep = document.createElement("div");
      sep.style.cssText = "height:1px;background:#2a2f45;margin:4px 0;";
      menu.appendChild(sep);
      continue;
    }

    const el = document.createElement("div");
    el.style.cssText = `
      padding:8px 14px; cursor:pointer;
      display:flex; align-items:center; gap:8px;
      transition:background .1s;
      ${item.danger   ? "color:#f38ba8;"                  : ""}
      ${item.disabled ? "opacity:.4;pointer-events:none;" : ""}
    `;
    el.innerHTML =
      `<span style="font-size:15px;width:18px;text-align:center">${item.icon ?? ""}</span>` +
      _esc(item.label);

    el.addEventListener("mouseenter", () => { el.style.background = "#2a2f45"; });
    el.addEventListener("mouseleave", () => { el.style.background = ""; });
    el.addEventListener("click",      () => { closeContextMenu(); item.action?.(); });
    menu.appendChild(el);
  }

  document.body.appendChild(menu);
  _activeMenu = menu;

  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = (x - r.width)  + "px";
    if (r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + "px";
  });

  setTimeout(() =>
    document.addEventListener("click", closeContextMenu, { once: true }), 0);
}

// ─── Image picker modal ───────────────────────────────────────────────────────

export function showImagePicker(modelName, images, onPick) {
  const overlay = _overlay();
  const box     = document.createElement("div");

  box.style.cssText = `
    background:#141824; border:1px solid #2a2f45; border-radius:10px;
    padding:18px; max-width:820px; width:90vw; max-height:72vh;
    display:flex; flex-direction:column; gap:12px;
    font-family:Inter,sans-serif; color:#cdd6f4;
  `;
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between">
      <span style="font-weight:700;color:#89b4fa;font-size:14px">
        Pick Thumbnail — ${_esc(modelName)}
        (${images.length} image${images.length !== 1 ? "s" : ""})
      </span>
      <button id="cwk-pk-close"
        style="background:none;border:none;color:#6c7086;font-size:20px;cursor:pointer">✕</button>
    </div>
    <div id="cwk-pk-grid" style="
      display:grid;
      grid-template-columns:repeat(auto-fill,minmax(130px,1fr));
      gap:8px; overflow-y:auto; flex:1; padding:4px;
    "></div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  box.querySelector("#cwk-pk-close").onclick = () => overlay.remove();
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  const grid = box.querySelector("#cwk-pk-grid");

  for (const img of images) {
    const url  = typeof img === "string" ? img : img.url;
    if (!url) continue;
    const nsfw = (img?.nsfwLevel ?? 0) > 1;
    const blur = nsfw ? "filter:blur(12px);" : "";

    const card = document.createElement("div");
    card.style.cssText = `
      position:relative; border-radius:6px; overflow:hidden; cursor:pointer;
      border:2px solid transparent; aspect-ratio:2/3; background:#1e2335;
      transition:border-color .15s;
    `;
    card.innerHTML = isVideoUrl(url)
      ? `<video src="${_esc(url)}" muted autoplay loop playsinline
           style="width:100%;height:100%;object-fit:cover;${blur}"></video>`
      : `<img src="${_esc(url)}" loading="lazy"
           style="width:100%;height:100%;object-fit:cover;${blur}"/>`;

    card.addEventListener("mouseenter", () => { card.style.borderColor = "#89b4fa"; });
    card.addEventListener("mouseleave", () => { card.style.borderColor = "transparent"; });
    card.addEventListener("click",      () => { onPick(url); overlay.remove(); });
    grid.appendChild(card);
  }
}

// ─── Version checker modal ────────────────────────────────────────────────────

export function showVersionChecker(modelName, apiKey, onDownloadDone) {
  const overlay = _overlay();
  const box     = document.createElement("div");

  box.style.cssText = `
    background:#141824; border:1px solid #2a2f45; border-radius:10px;
    padding:18px; max-width:700px; width:90vw; max-height:75vh;
    display:flex; flex-direction:column; gap:12px;
    font-family:Inter,sans-serif; color:#cdd6f4;
  `;
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between">
      <span style="font-weight:700;color:#89b4fa;font-size:14px">
        Model Versions — ${_esc(modelName)}
      </span>
      <button id="cwk-ver-close"
        style="background:none;border:none;color:#6c7086;font-size:20px;cursor:pointer">✕</button>
    </div>
    <div id="cwk-ver-list"
      style="overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px;">
      <div style="color:#6c7086;font-size:13px;padding:8px 0">Loading versions…</div>
    </div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  box.querySelector("#cwk-ver-close").onclick = () => overlay.remove();
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  const list = box.querySelector("#cwk-ver-list");

  // ── Fetch version list ─────────────────────────────────────────────────────
  fetch(
    `/cwk/civitai/versions` +
    `?model=${encodeURIComponent(modelName)}` +
    `&api_key=${encodeURIComponent(apiKey)}`
  )
    .then(r => r.json())
    .then(({ versions, error }) => {
      if (error) {
        list.innerHTML =
          `<div style="color:#f38ba8;font-size:13px;padding:8px 0">${_esc(error)}</div>`;
        return;
      }
      if (!versions?.length) {
        list.innerHTML =
          `<div style="color:#6c7086;font-size:13px;padding:8px 0">No versions found.</div>`;
        return;
      }

      list.innerHTML = "";

      for (const v of versions) {
        const row   = document.createElement("div");
        const thumb = v.images?.[0]?.url ?? "";
        const size  = fmtSize(v.size_kb);
        const date  = v.created_at?.slice(0, 10) ?? "";

        row.style.cssText = `
          background:#1e2335; border:1px solid #313552; border-radius:8px;
          padding:12px; display:flex; align-items:center; gap:12px;
        `;

        // ── Thumbnail ─────────────────────────────────────────���────────────
        const thumbEl = document.createElement("div");
        thumbEl.style.cssText = `width:48px;height:64px;flex-shrink:0;border-radius:4px;overflow:hidden;background:#181d2e;display:flex;align-items:center;justify-content:center;font-size:20px;`;
        if (thumb) {
          const img = document.createElement("img");
          img.src              = thumb;
          img.loading          = "lazy";
          img.style.cssText    = "width:100%;height:100%;object-fit:cover;";
          thumbEl.appendChild(img);
        } else {
          thumbEl.textContent = "🖼";
        }

        // ── Info column ────────────────────────────────────────────────────
        const infoCol = document.createElement("div");
        infoCol.style.cssText = "flex:1;min-width:0;";

        const nameEl = document.createElement("div");
        nameEl.style.cssText = `font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;${v.is_installed ? "color:#a6e3a1;" : ""}`;
        nameEl.textContent = v.name;

        if (v.is_installed) {
          const installedBadge = document.createElement("span");
          installedBadge.style.cssText = "font-size:11px;color:#a6e3a1;";
          installedBadge.textContent   = v.is_current ? "✓ installed (current)" : "✓ installed";
          nameEl.appendChild(installedBadge);
        }

        if (v.early_access_ends) {
          const deadline = new Date(v.early_access_ends);
          const isEarlyAccess = deadline > new Date();
          if (isEarlyAccess) {
            const eaBadge = document.createElement("span");
            eaBadge.textContent   = `⏳ Early Access · until ${deadline.toLocaleDateString()}`;
            eaBadge.style.cssText = `
              font-size:10px; font-weight:700;
              background:#f9e2af; color:#1e1e2e;
              border-radius:4px; padding:2px 6px;
              white-space:nowrap;
            `;
            nameEl.appendChild(eaBadge);
          }
        }

        const metaEl = document.createElement("div");
        metaEl.style.cssText = "font-size:11px;color:#6c7086;margin-top:3px;";
        metaEl.textContent   = [v.base_model, size, date].filter(Boolean).join(" · ");

        const fileEl = document.createElement("div");
        fileEl.style.cssText = "font-size:10px;color:#45475a;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        fileEl.textContent   = v.filename ?? "";

        // ── Per-row progress bar ───────────────────────────────────────────
        const progressWrap = document.createElement("div");
        progressWrap.style.cssText = `
          display:none; margin-top:8px; height:4px; border-radius:2px;
          background:#2a2f45; overflow:hidden;
        `;
        const progressBar = document.createElement("div");
        progressBar.style.cssText = `
          height:100%; width:0%; background:#89b4fa;
          transition:width .15s ease; border-radius:2px;
        `;
        progressWrap.appendChild(progressBar);

        infoCol.appendChild(nameEl);
        infoCol.appendChild(metaEl);
        if (v.filename) infoCol.appendChild(fileEl);
        infoCol.appendChild(progressWrap);

        // ── Action buttons column ──────────────────────────────────────────
        const actionsCol = document.createElement("div");
        actionsCol.style.cssText = "flex-shrink:0;display:flex;flex-direction:column;gap:6px;align-items:stretch;";

        if (!v.is_installed && v.download_url) {
          const dlBtn = document.createElement("button");
          dlBtn.className    = "cwk-ver-dl";
          dlBtn.dataset.url  = v.download_url;
          dlBtn.dataset.fn   = v.filename ?? "";
          dlBtn.textContent  = "⬇ Download";
          dlBtn.style.cssText = `
            padding:6px 12px; border-radius:6px; border:none;
            background:#89b4fa; color:#1e1e2e;
            font-size:12px; font-weight:700; cursor:pointer; min-width:90px; text-align:center;
          `;
          actionsCol.appendChild(dlBtn);
        }

        if (v.is_installed) {
          const delBtn = document.createElement("button");
          delBtn.className      = "cwk-ver-del";
          delBtn.dataset.model  = modelName;
          delBtn.textContent    = "🗑 Delete";
          delBtn.style.cssText  = `
            padding:6px 12px; border-radius:6px; border:1px solid #f38ba8;
            background:transparent; color:#f38ba8;
            font-size:12px; font-weight:700; cursor:pointer; min-width:90px; text-align:center;
          `;
          actionsCol.appendChild(delBtn);
        }

        row.appendChild(thumbEl);
        row.appendChild(infoCol);
        row.appendChild(actionsCol);
        list.appendChild(row);
      }

      // ── Wire up download buttons ───────────────────────────────────────────
      list.querySelectorAll(".cwk-ver-dl").forEach(btn => {
        btn.addEventListener("click", async () => {
          const dlUrl      = btn.dataset.url;
          const fn         = btn.dataset.fn;
          const row        = btn.closest("div[style*='background:#1e2335']");
          const infoCol    = row?.querySelector("div[style*='flex:1']");
          const pWrap      = infoCol?.querySelector("div[style*='height:4px']");
          const pBar       = pWrap?.firstElementChild;

          btn.disabled    = true;
          btn.textContent = "0%";
          if (pWrap) pWrap.style.display = "block";

          try {
            const response = await fetch("/cwk/civitai/download", {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({
                model:        modelName,
                download_url: dlUrl,
                filename:     fn,
                api_key:      apiKey,
              }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const reader = response.body.getReader();
            const dec    = new TextDecoder();
            let   buf    = "";

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              const parts = buf.split("\n\n");
              buf = parts.pop();

              for (const part of parts) {
                const line = part.trim();
                if (!line.startsWith("data:")) continue;
                let p;
                try { p = JSON.parse(line.slice(5)); } catch { continue; }

                if (p.progress !== undefined) {
                  btn.textContent = `${p.progress}%`;
                  if (pBar) pBar.style.width = `${p.progress}%`;
                }
                if (p.done && !p.error) {
                  btn.textContent      = "✓ Done";
                  btn.style.background = "#a6e3a1";
                  btn.style.color      = "#1e1e2e";
                  if (pBar) {
                    pBar.style.width      = "100%";
                    pBar.style.background = "#a6e3a1";
                  }
                  // Pass civitai metadata and registered name if the server
                  // fetched it inline — panel can update the card immediately
                  onDownloadDone?.("downloaded", p.civitai ?? null, p.registered_name ?? null);
                }
                if (p.error) {
                  btn.textContent      = "✗ Error";
                  btn.style.background = "#f38ba8";
                  btn.style.color      = "#1e1e2e";
                  btn.title            = p.error;
                  btn.disabled         = false;
                  if (pWrap) pWrap.style.display = "none";
                }
              }
            }
          } catch (e) {
            btn.textContent      = "✗ Failed";
            btn.style.background = "#f38ba8";
            btn.style.color      = "#1e1e2e";
            btn.title            = e.message;
            btn.disabled         = false;
            if (pWrap) pWrap.style.display = "none";
          }
        });
      });

      // ── Wire up delete buttons ─────────────────────────────────────────────
      list.querySelectorAll(".cwk-ver-del").forEach(btn => {
        btn.addEventListener("click", async () => {
          const modelToDelete = btn.dataset.model;
          if (!confirm(`Permanently delete "${modelToDelete}"?\n\nThis cannot be undone.`)) return;

          btn.disabled    = true;
          btn.textContent = "Deleting…";

          try {
            const res  = await fetch("/cwk/model", {
              method:  "DELETE",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ model: modelToDelete }),
            });
            const data = await res.json();
            if (data.ok) {
              const row = btn.closest("div[style*='background:#1e2335']");
              if (row) {
                row.style.opacity       = "0.4";
                row.style.pointerEvents = "none";
              }
              btn.textContent     = "✓ Deleted";
              btn.style.color     = "#6c7086";
              btn.style.border    = "1px solid #45475a";
              onDownloadDone?.("deleted");
            } else {
              btn.textContent = "✗ Failed";
              btn.style.color = "#f38ba8";
              btn.title       = data.errors?.join(", ") ?? "Delete failed";
              btn.disabled    = false;
            }
          } catch (e) {
            btn.textContent = "✗ Failed";
            btn.style.color = "#f38ba8";
            btn.title       = e.message;
            btn.disabled    = false;
          }
        });
      });
    })
    .catch(e => {
      list.innerHTML =
        `<div style="color:#f38ba8;font-size:13px;padding:8px 0">
           Failed to load versions: ${_esc(e.message)}
         </div>`;
    });
}