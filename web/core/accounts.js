// The accounts the home deck shows: a bank card per enabled currency, then a phone line per SIM.

/** A card's balance: its currency's latest verified balance query, or null. */
export function balanceFor(attempts, currency) {
  return attempts.find((a) => a.op === "46" && a.state === "verified" && a.currency === currency)?.available ?? null;
}

export function accounts(state, sims) {
  const { bank, enabledCurrencies, plans } = state.settings;
  const cards = enabledCurrencies.map((currency) => ({
    kind: "card", id: `card:${currency}`, bank, currency, label: `Tarjeta ${currency}`,
    balance: balanceFor(state.attempts, currency),
  }));
  const lines = sims.map(({ subId, slot, carrier }) => ({
    kind: "line", id: `line:${subId}`, subId, slot, carrier, label: `SIM ${slot + 1} · ${carrier}`,
    plan: plans[subId] ?? "PREPAGO", balance: state.mobileBalances[subId] ?? null,
  }));
  return [...cards, ...lines];
}
