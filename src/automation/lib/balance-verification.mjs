export function isRechargeBalanceIncreaseVerified(beforeBalance, afterBalance) {
  if (!Number.isFinite(beforeBalance) || !Number.isFinite(afterBalance)) return false;
  return afterBalance > beforeBalance;
}
