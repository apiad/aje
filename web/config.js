// The build's config.json: version, commit and telemetry endpoint. Served without a build (the browser
// during development) there is none, and dev values stand in.
export async function loadConfig() {
  try {
    const res = await fetch("./config.json");
    if (res.ok) return await res.json();
  } catch {
    // Served without a build.
  }
  return { app: "dev", commit: "", telemetryUrl: "", telemetryToken: "" };
}
