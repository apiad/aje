// The accounts the home deck shows: the stored cards in the order they were added, then a phone line per SIM.

/** A card's balance: its latest verified balance query, or null. */
export function balanceFor(attempts, cardId) {
  return attempts.find((a) => a.op === "46" && a.state === "verified" && a.cardId === cardId)?.available ?? null;
}

export function accounts(state, sims) {
  const { plans } = state.settings;
  const cards = state.cards.map((c) => ({
    kind: "card", id: `card:${c.id}`, cardId: c.id, bank: c.bank, currency: c.currency, pan: c.pan, label: c.alias,
    pending: c.state === "pending", step: c.step, balance: balanceFor(state.attempts, c.id),
  }));
  const lines = sims.map(({ subId, slot, carrier }) => ({
    kind: "line", id: `line:${subId}`, subId, slot, carrier, label: `SIM ${slot + 1} · ${carrier}`,
    plan: plans[subId] ?? "PREPAGO", balance: state.mobileBalances[subId] ?? null, details: state.mobileDetails?.[subId] ?? null,
  }));
  return [...cards, ...lines];
}
