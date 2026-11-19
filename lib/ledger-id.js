/**
 * Shared validation for secondary ledger directory identifiers (`ledger-2` .. `ledger-999`).
 * The default ledger uses id `'default'` and stores directly under `data/`.
 */
const SECONDARY_LEDGER_ID_PATTERN = /^ledger-[2-9]$|^ledger-[1-9][0-9]{1,2}$/;

function isSecondaryLedgerId(id) {
  return typeof id === 'string' && SECONDARY_LEDGER_ID_PATTERN.test(id);
}

module.exports = {
  SECONDARY_LEDGER_ID_PATTERN,
  isSecondaryLedgerId
};
