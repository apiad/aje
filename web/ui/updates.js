// Updates as the screens show them: the automatic check on opening the app, "Buscar actualización", and the
// "Actualizar" button that hands the release's APK to the shell (installUpdate).
import { checkForUpdate, shouldAutoCheck } from "../core/update.js";
import { h } from "./dom.js";

const REASONS = {
  permission: "Android pide permitir que Ajé instale apps. Actívalo y vuelve a tocar Actualizar.",
  checksum: "La descarga no coincide con la release; no se instaló.",
  signature: "El APK no está firmado como esta app; no se instaló.",
  version: "Esa versión no es más nueva que la instalada.",
  apk: "El archivo descargado no es un APK de Ajé.",
  release: "La release no es de Ajé; no se descargó.",
  download: "No se pudo descargar. Revisa la conexión y vuelve a intentarlo.",
};

export const currentCode = (ctx) => Number(ctx.config.versionCode ?? 0);

/** Asks GitHub now; keeps the result, so Inicio and Ajustes show the same update. */
export async function checkNow(ctx) {
  const update = await checkForUpdate({
    fetch: (url) => globalThis.fetch(url), channel: ctx.store.state.settings.channel, currentCode: currentCode(ctx),
  });
  await ctx.store.setUpdate({ checkedAt: Date.now(), available: update });
  return update;
}

/** On opening or returning to the app, at most once an hour, quietly: a failed check shows nothing. */
export function autoCheck(ctx) {
  if (shouldAutoCheck(ctx.store.state.update.checkedAt, Date.now())) checkNow(ctx).catch(() => {});
}

/** The update the last check found, if it is still newer than this build. */
export function pending(ctx) {
  const u = ctx.store.state.update.available;
  return u && u.versionCode > currentCode(ctx) ? u : null;
}

/** "Actualizar a X": downloads, verifies and opens Android's installer; says why when it cannot. */
export function updateButton(ctx, u, id) {
  const status = h("div", { class: "hint", id: `${id}-status` });
  const bar = h("progress", { class: "dl", id: `${id}-bar`, max: "1", value: "0", hidden: true });
  const button = h("button", { id, class: "btn gold" }, `Actualizar a ${u.version}`);
  const mb = (n) => (n / 1e6).toFixed(1).replace(".", ",");
  const progress = (received, total) => {
    total = total > 0 ? total : u.size ?? 0;
    bar.hidden = false;
    if (total > 0) bar.value = Math.min(received / total, 1);
    else bar.removeAttribute("value");
    status.textContent = total > 0 && received >= total ? "Verificando…" : `Descargando ${mb(received)}${total > 0 ? ` de ${mb(total)}` : ""} MB…`;
  };
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    progress(0, u.size ?? 0);
    try {
      const r = await ctx.bridge.installUpdate(u.apkUrl, u.sha256, progress);
      status.textContent = r.ok ? "Se abrió el instalador de Android." : REASONS[r.reason] ?? `No se instaló (${r.reason}).`;
    } catch (e) {
      status.textContent = `No se instaló: ${e.message}`;
    } finally {
      button.disabled = false;
      bar.hidden = true;
    }
  });
  return h("div", {}, button, bar, status);
}

/** The banner on Inicio while an update is waiting. */
export function updateBanner(ctx) {
  const u = pending(ctx);
  return u ? h("div", { class: "banner", id: "update-banner" },
    h("div", {}, h("b", {}, `Ajé ${u.version} disponible`), u.prerelease ? " · beta" : ""), updateButton(ctx, u, "update-home")) : null;
}

/** The Ajustes group: channel, the running version, and a check on demand. */
export function updateSettings(ctx, chips) {
  const s = ctx.store.state.settings;
  // Ajustes redraws on every store change, so the result is read from the stored check.
  const { checkedAt, available } = ctx.store.state.update;
  const result = h("div", { class: "hint", id: "update-result" }, checkedAt === null ? ""
    : pending(ctx) ? `Hay una versión nueva: ${available.version}.` : "Tienes la última versión de tu canal.");
  const found = h("div", { id: "update-found" });
  const show = (u) => found.replaceChildren(...(u ? [updateButton(ctx, u, "update-settings")] : []));
  show(pending(ctx));
  const check = h("button", { id: "update-check", class: "btn ghost" }, "Buscar actualización");
  check.addEventListener("click", async () => {
    check.disabled = true;
    result.textContent = "Buscando…";
    try {
      await checkNow(ctx);
    } catch (e) {
      result.textContent = `No se pudo consultar GitHub: ${e.message}`;
    } finally {
      check.disabled = false;
    }
  });
  return [
    h("div", { class: "group" }, "Actualizaciones"),
    chips([["stable", "Estable"], ["beta", "Beta"]], (v) => s.channel === v, async (v) => {
      await ctx.store.update({ channel: v });
      await ctx.store.setUpdate({ checkedAt: null, available: null });
    }),
    h("div", { class: "hint" }, `Versión instalada: ${ctx.config.app}. Beta recibe también las versiones de prueba.`),
    check, result, found,
  ];
}
