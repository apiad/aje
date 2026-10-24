// The accounts the home deck shows: the stored cards in the order they were added, then a phone line per SIM.

/**
 * A card's balance: the one its latest bank SMS left on it, else its latest verified balance query in
 * the history (a card stored before balances were kept on it), or null.
 */
export function balanceFor(state, cardId) {
  return state.cards.find((c) => c.id === cardId)?.balance?.available ??
    state.attempts.find((a) => a.op === "46" && a.state === "verified" && a.cardId === cardId)?.available ?? null;
}

/** The cards not removed, in the person's order, the default one first. */
export function liveCards(state) {
  const live = state.cards.filter((c) => !c.removed);
  const d = state.settings.defaultCard;
  return [...live.filter((c) => c.id === d), ...live.filter((c) => c.id !== d)];
}

export const simLabel = ({ slot, carrier }) => `SIM ${slot + 1} · ${carrier || "Cubacel"}`;

export function accounts(state, sims) {
  const { plans, lines: named = {} } = state.settings;
  const cards = liveCards(state).map((c) => ({
    kind: "card", id: `card:${c.id}`, cardId: c.id, bank: c.bank, currency: c.currency, pan: c.pan, label: c.alias,
    pending: c.state === "pending", step: c.step, balance: balanceFor(state, c.id), isDefault: c.id === state.settings.defaultCard,
  }));
  const shown = sims.filter(({ subId }) => !named[subId]?.hidden);
  const lines = [...shown.filter((x) => x.subId === state.settings.subId), ...shown.filter((x) => x.subId !== state.settings.subId)].map(({ subId, slot, carrier }) => ({
    kind: "line", id: `line:${subId}`, subId, slot, carrier, label: named[subId]?.alias || simLabel({ slot, carrier }),
    isDefault: subId === state.settings.subId,
    plan: plans[subId] ?? "PREPAGO", balance: state.mobileBalances[subId] ?? null, details: state.mobileDetails?.[subId] ?? null,
  }));
  return [...cards, ...lines];
}
