// src/utils/pointsCalculator.js
// Shared formula for a Module/Topic's displayed "pointsReward" — matches the
// baseline of the ad-hoc frontend formula it replaces (Math.max(50, cards*10))
// plus an additive time bonus, so existing displayed numbers don't jump sharply
// once real backend values replace the old client-side estimate.
const computePointsReward = (cardCount, estimatedTime = 0) => {
  const base = Math.max(50, (cardCount || 0) * 10);
  const timeBonus = Math.round((estimatedTime || 0) * 2);
  return base + timeBonus;
};

module.exports = { computePointsReward };
