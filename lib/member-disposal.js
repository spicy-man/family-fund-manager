const Decimal = require('decimal.js');
const { previewDisposalFee } = require('./performance-settlement');

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

function takeLotsProRata(lots, shareRatio) {
  let remainingShares = ZERO;
  for (const lot of lots) {
    const shares = lot.shares.mul(shareRatio);
    const basis = lot.basis.mul(shareRatio);
    lot.shares = lot.shares.minus(shares);
    lot.basis = lot.basis.minus(basis);
    remainingShares = remainingShares.plus(lot.shares);
  }
  for (let index = lots.length - 1; index >= 0; index--) {
    if (lots[index].shares.isZero()) lots.splice(index, 1);
  }
  return remainingShares;
}

/**
 * Applies the shared economic disposal used by both withdrawals and internal
 * transfers. The caller remains responsible for external cash flow or for
 * creating the recipient's new acquisition lot.
 */
function disposeMemberPosition({
  event,
  member,
  gpMember,
  currentNAV,
  requestedAmount,
  eventCnhAmount,
  autoFullExit,
  captureAccountValueBefore,
  output,
  includeLotDetails,
  metrics
}) {
  const sharesBefore = member.shares;
  const carrySharesBefore = member.carryShares;
  const lpSharesBefore = member.lpShares;
  const accountValueBefore = sharesBefore.mul(currentNAV);
  const requestAccountValue = accountValueBefore.toDecimalPlaces(2);
  const fullExitTolerance = Decimal.max(new Decimal('0.000001'), requestAccountValue.mul('1e-10'));
  const isFullExit = event.fullExit === true || (
    autoFullExit && requestedAmount.minus(requestAccountValue).abs().lte(fullExitTolerance)
  );
  if (captureAccountValueBefore) event._accountValueBefore = output(requestAccountValue, 2);

  let cashShares = Decimal.min(requestedAmount.div(currentNAV), sharesBefore);
  let actualAmount = cashShares.mul(currentNAV);
  let lpSharesDisposed = Decimal.min(cashShares, lpSharesBefore);
  const isSelfGp = gpMember === member;
  const usesNetDisposal = Number(event.performanceFee?.disposalVersion || 1) >= 2;
  if (isFullExit) lpSharesDisposed = lpSharesBefore;

  const disposal = gpMember ? previewDisposalFee({
    member,
    currentNAV,
    date: event.date,
    lpSharesDisposed,
    netCashAmount: isFullExit || !usesNetDisposal
      ? undefined
      : lpSharesDisposed.mul(currentNAV),
    annualRate: new Decimal(event.performanceFee.annualRate),
    feeRate: new Decimal(event.performanceFee.feeRate),
    output,
    includeLotDetails,
    legacyDisposal: !usesNetDisposal,
    metrics
  }) : {
    fee: ZERO,
    feeShares: ZERO,
    cashShares: lpSharesDisposed,
    ratio: lpSharesBefore.isZero() ? ZERO : lpSharesDisposed.div(lpSharesBefore),
    lots: []
  };

  if (usesNetDisposal && !isFullExit) {
    lpSharesDisposed = Decimal.min(lpSharesBefore, disposal.cashShares);
    // Once every LP lot is disposed, any additional cash must come from
    // carry already owned by this member. Never manufacture carry by
    // clamping its remaining balance to zero after paying too much cash.
    const availableCashShares = Decimal.max(ZERO, lpSharesDisposed.plus(carrySharesBefore));
    if (cashShares.gt(availableCashShares)) {
      cashShares = availableCashShares;
      actualAmount = cashShares.mul(currentNAV);
      eventCnhAmount = requestedAmount.isZero()
        ? ZERO
        : eventCnhAmount.mul(actualAmount.div(requestedAmount));
    }
  }
  const feeShares = isFullExit
    ? Decimal.min(disposal.feeShares, lpSharesBefore)
    : Decimal.min(disposal.feeShares, Decimal.max(ZERO, lpSharesBefore.minus(lpSharesDisposed)));

  if (isFullExit) {
    cashShares = isSelfGp
      ? sharesBefore
      : lpSharesBefore.minus(feeShares).plus(carrySharesBefore);
    actualAmount = cashShares.mul(currentNAV);
    eventCnhAmount = requestedAmount.isZero()
      ? ZERO
      : eventCnhAmount.mul(actualAmount.div(requestedAmount));
  }

  const carrySharesDisposed = isFullExit
    ? carrySharesBefore
    : Decimal.max(ZERO, cashShares.minus(lpSharesDisposed));
  const grossAmount = isFullExit ? sharesBefore.mul(currentNAV) : actualAmount;

  if (!lpSharesBefore.isZero()) {
    if (gpMember) {
      member.lots = disposal.remainingLots;
      member.lpShares = disposal.remainingLpShares;
    } else {
      member.lpShares = takeLotsProRata(member.lots, isFullExit ? ONE : disposal.ratio);
    }
  }
  member.carryShares = isFullExit
    ? ZERO
    : Decimal.max(ZERO, member.carryShares.minus(cashShares.minus(lpSharesDisposed)));
  member.shares = isSelfGp && isFullExit
    ? member.shares.minus(cashShares)
    : member.shares.minus(cashShares.plus(feeShares));

  if (gpMember && feeShares.gt(ZERO) && !(isSelfGp && isFullExit)) {
    gpMember.shares = gpMember.shares.plus(feeShares);
    gpMember.carryShares = gpMember.carryShares.plus(feeShares);
  }

  return {
    sharesBefore,
    carrySharesBefore,
    lpSharesBefore,
    cashShares,
    lpSharesDisposed,
    actualAmount,
    eventCnhAmount,
    grossAmount,
    carrySharesDisposed,
    feeShares,
    disposal,
    isFullExit,
    usesNetDisposal
  };
}

module.exports = { disposeMemberPosition };
