// Boot. Task 9 replaces this with the real app; for now it proves the bridge from the shell.
import { connect } from "./bridge.js";

const bridge = await connect();
const sims = await bridge.listSims();
document.getElementById("app").textContent = `bridge: ${bridge.kind} · SIM: ${sims.length}`;
