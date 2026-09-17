/** Round a quota ratio so float noise does not flip eligibility comparisons. */
export function roundRatio(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
