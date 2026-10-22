import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdate, parseRelease, pickUpdate, shouldAutoCheck } from "../core/update.js";

const asset = (name) => ({ name, browser_download_url: `https://github.com/apiad/aje/releases/download/x/${name}`, size: 7_000_000, digest: `sha256:${"ab".repeat(32)}` });
const release = (tag, code, prerelease = false, draft = false) => ({
  tag_name: tag, name: tag, prerelease, draft, html_url: `https://github.com/apiad/aje/releases/tag/${tag}`,
  assets: [asset(`aje-${tag.slice(1)}-${code}.apk`), asset(`aje-${tag.slice(1)}-${code}.apk.sha256`)],
});
const RELEASES = [
  release("v1.1.0-beta.1", 270, true),
  release("v1.0.1", 262),
  release("v1.0.0", 255),
  release("v1.2.0", 300, false, true),
  { tag_name: "v0.9", prerelease: false, draft: false, assets: [] },
];

test("parseRelease reads the APK, its checksum from the API and the version code", () => {
  const r = parseRelease(RELEASES[1]);
  assert.equal(r.version, "1.0.1");
  assert.equal(r.versionCode, 262);
  assert.match(r.apkUrl, /aje-1\.0\.1-262\.apk$/);
  assert.equal(r.sha256, "ab".repeat(32));
  assert.equal(parseRelease(RELEASES[4]), null);
});

test("stable takes the newest normal release; beta also takes pre-releases; drafts never", () => {
  assert.equal(pickUpdate(RELEASES, { channel: "stable", currentCode: 255 }).version, "1.0.1");
  assert.equal(pickUpdate(RELEASES, { channel: "beta", currentCode: 255 }).version, "1.1.0-beta.1");
  assert.equal(pickUpdate(RELEASES, { channel: "stable", currentCode: 262 }), null);
  assert.equal(pickUpdate(RELEASES, { channel: "beta", currentCode: 270 }), null);
});

// Release downloads on github.com answer without CORS headers, so a page cannot read them:
// the checksum comes from the API's asset digest, and the page makes one request.
test("checkForUpdate makes one request and takes the checksum from the asset digest", async () => {
  const urls = [];
  const fetch = async (url) => { urls.push(url); return { ok: true, json: async () => RELEASES }; };
  const u = await checkForUpdate({ fetch, channel: "stable", currentCode: 255 });
  assert.deepEqual(urls, ["https://api.github.com/repos/apiad/aje/releases?per_page=30"]);
  assert.equal(u.sha256, "ab".repeat(32));
  assert.equal(await checkForUpdate({ fetch, channel: "stable", currentCode: 262 }), null);
});

test("a release whose APK has no sha256 digest is skipped", async () => {
  const bare = structuredClone(RELEASES);
  delete bare[1].assets[0].digest;
  const fetch = async () => ({ ok: true, json: async () => bare });
  assert.equal((await checkForUpdate({ fetch, channel: "stable", currentCode: 0 })).version, "1.0.0");
});

test("checkForUpdate reports GitHub's status when it fails", async () => {
  const fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(checkForUpdate({ fetch, channel: "stable", currentCode: 1 }), /403/);
});

test("the automatic check runs at most once a day", () => {
  const DAY = 86_400_000;
  assert.equal(shouldAutoCheck(null, 5), true);
  assert.equal(shouldAutoCheck(1, 1 + DAY - 1), false);
  assert.equal(shouldAutoCheck(1, 1 + DAY), true);
});
