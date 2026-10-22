// Updates from the project's GitHub releases. The stable channel takes normal releases; the beta
// channel also takes pre-releases. Each release carries `aje-<version>-<versionCode>.apk`, whose
// SHA-256 the API reports as the asset's digest; the shell downloads the APK and installs it only if
// both the checksum and the signing certificate match (installUpdate in NativeBridge). Release
// downloads on github.com send no CORS headers, so the page reads nothing but the API.

export const RELEASES_URL = "https://api.github.com/repos/apiad/aje/releases?per_page=30";
const DAY_MS = 86_400_000;
const APK = /^aje-(.+)-(\d+)\.apk$/;

/** The update a release offers, or null when it carries no APK named by the convention. */
export function parseRelease(r) {
  const apk = r.assets?.find((a) => APK.test(a.name));
  if (!apk) return null;
  const [, version, code] = APK.exec(apk.name);
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(apk.digest ?? "")?.[1] ?? null;
  return {
    tag: r.tag_name, version, versionCode: Number(code), prerelease: Boolean(r.prerelease), page: r.html_url ?? null,
    apkUrl: apk.browser_download_url, sha256, size: apk.size ?? null,
  };
}

/** The newest release in the channel that is newer than the running build, or null. */
export function pickUpdate(releases, { channel, currentCode }) {
  return releases
    .filter((r) => !r.draft && (channel === "beta" || !r.prerelease))
    .map(parseRelease)
    .filter((u) => u && u.sha256 && u.versionCode > currentCode)
    .sort((a, b) => b.versionCode - a.versionCode)[0] ?? null;
}

/** Asks GitHub for the releases and returns the update with its checksum, or null when up to date. */
export async function checkForUpdate({ fetch, channel, currentCode }) {
  const res = await fetch(RELEASES_URL);
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
  return pickUpdate(await res.json(), { channel, currentCode });
}

export const shouldAutoCheck = (lastAt, now) => lastAt === null || now - lastAt >= DAY_MS;
