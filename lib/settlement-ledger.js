const { isDeepStrictEqual } = require('util');
const { calculateStateFromDb } = require('./calculator');
const { compareEvents, compareEventCreationOrder } = require('./event-order');
const {
  LEGACY_SETTLEMENT_VERSION,
  INDEPENDENT_LOT_SETTLEMENT_VERSION,
  CURRENT_SETTLEMENT_VERSION
} = require('./performance-settlement');

const SUPPORTED_SETTLEMENT_VERSIONS = [
  LEGACY_SETTLEMENT_VERSION,
  INDEPENDENT_LOT_SETTLEMENT_VERSION,
  CURRENT_SETTLEMENT_VERSION
];
const UNVERSIONED_SETTLEMENT_VERSIONS = [
  LEGACY_SETTLEMENT_VERSION,
  INDEPENDENT_LOT_SETTLEMENT_VERSION
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function activeSettlementRecords(records) {
  const reversedIds = new Set(records
    .filter(record => record.type === 'performance_settlement_reversal')
    .map(record => record.settlementId));
  return records.filter(record =>
    record.type === 'performance_settlement_reversal' ||
    (record.type === 'performance_settlement' && !reversedIds.has(record.id))
  );
}

function mergeSettlementLedger(db, ledger) {
  const baseEvents = db.events.filter(event =>
    event.type !== 'performance_settlement' &&
    event.type !== 'performance_settlement_reversal'
  );
  return {
    ...db,
    events: [...baseEvents, ...activeSettlementRecords(ledger.records || [])]
  };
}

function isAtOrBefore(event, cutoff) {
  return compareEvents(event, cutoff) <= 0;
}

function snapshotFromComputed(event) {
  return {
    breakdown: event._breakdown,
    totalFee: event._totalFee,
    feeShares: event._feeShares,
    navPerShare: event._navAtTx
  };
}

// Member rows are keyed by identity; their display order is not accounting data.
// Preserve lot order and every amount when comparing older numeric-ID snapshots.
function comparableSnapshot(snapshot) {
  if (!Array.isArray(snapshot?.breakdown)) return snapshot;
  return { ...snapshot, breakdown: [...snapshot.breakdown].sort((a, b) =>
    String(a.member).localeCompare(String(b.member))) };
}

function stateSignature(state) {
  return {
    summary: {
      totalNAV: state.summary.totalNAV,
      totalShares: state.summary.totalShares,
      navPerShare: state.summary.navPerShare
    },
    members: Object.fromEntries(Object.entries(state.members).map(([id, member]) => [id, {
      shares: member.shares,
      lpShares: member.lpShares,
      gpCarryShares: member.gpCarryShares,
      lpLedger: member.lpLedger
    }]))
  };
}

function replayCandidate(baseDb, processedRecords, record, algorithmVersion) {
  const candidate = { ...clone(record), algorithmVersion };
  const recordsAtConfirmation = [...processedRecords, candidate];
  const activeAtConfirmation = activeSettlementRecords(recordsAtConfirmation)
    .filter(item => item.type === 'performance_settlement');
  const normalEvents = baseDb.events
    .filter(event => event.type !== 'performance_settlement' && event.type !== 'performance_settlement_reversal')
    .filter(event => isAtOrBefore(event, candidate));
  const state = calculateStateFromDb({
    ...clone(baseDb),
    events: [...normalEvents, ...activeAtConfirmation]
  });
  const computed = state.events.find(event => event.id === candidate.id);
  if (!computed) throw new Error(`无法重放业绩结算记录：${candidate.id}`);
  return {
    record: candidate,
    snapshot: snapshotFromComputed(computed),
    stateSignature: stateSignature(state)
  };
}

function inferReversedVersionFromSnapshot(snapshot) {
  const lots = (snapshot.breakdown || []).flatMap(item => item.lots || []);
  if (lots.length === 0) return CURRENT_SETTLEMENT_VERSION;
  const v2Lots = lots.filter(lot =>
    Object.prototype.hasOwnProperty.call(lot, 'fee') &&
    Object.prototype.hasOwnProperty.call(lot, 'feeShares')
  );
  if (v2Lots.length === lots.length) return INDEPENDENT_LOT_SETTLEMENT_VERSION;
  if (v2Lots.length === 0) return LEGACY_SETTLEMENT_VERSION;
  throw new Error('锁定快照混用了不同版本的批次明细格式。');
}

function migrateSettlementLedger(baseDb, ledger) {
  if (!ledger || ledger.version !== 1 || !Array.isArray(ledger.records)) {
    throw new Error('独立结算账本格式无效。');
  }
  if (ledger.lastEventSequence !== undefined &&
      (!Number.isSafeInteger(ledger.lastEventSequence) || ledger.lastEventSequence < 0)) {
    throw new Error('独立结算账本包含无效的事件顺序号高水位。');
  }

  const orderedRecords = [...ledger.records].sort(compareEventCreationOrder);
  const processedRecords = [];
  const reversedIds = new Set(orderedRecords
    .filter(record => record.type === 'performance_settlement_reversal')
    .map(record => record.settlementId));
  let migratedCount = 0;
  let settlementCount = 0;

  for (const original of orderedRecords) {
    if (original.type !== 'performance_settlement') {
      processedRecords.push(clone(original));
      continue;
    }

    settlementCount += 1;
    const explicitVersion = original.algorithmVersion === undefined
      ? null
      : Number(original.algorithmVersion);
    if (explicitVersion !== null && !SUPPORTED_SETTLEMENT_VERSIONS.includes(explicitVersion)) {
      throw new Error(`结算记录 ${original.id} 使用了不支持的算法版本：${original.algorithmVersion}`);
    }
    if (!original.snapshot || typeof original.snapshot !== 'object') {
      throw new Error(`结算记录 ${original.id} 缺少锁定快照，无法安全重放。`);
    }

    // Once a settlement is reversed, its formerly locked period can be edited.
    // Its old snapshot can therefore legitimately stop matching today's base
    // ledger. The snapshot shape still identifies the frozen v1/v2 algorithm,
    // and the record is never applied to the active balance.
    if (reversedIds.has(original.id)) {
      const algorithmVersion = explicitVersion ?? inferReversedVersionFromSnapshot(original.snapshot);
      if (explicitVersion === null) migratedCount += 1;
      processedRecords.push({ ...clone(original), algorithmVersion });
      continue;
    }

    const versions = explicitVersion === null
      ? UNVERSIONED_SETTLEMENT_VERSIONS
      : [explicitVersion];
    const outcomes = versions.map(version =>
      replayCandidate(baseDb, processedRecords, original, version)
    );
    const matching = outcomes.filter(outcome =>
      isDeepStrictEqual(comparableSnapshot(outcome.snapshot), comparableSnapshot(original.snapshot))
    );

    if (matching.length === 0) {
      throw new Error(`结算记录 ${original.id} 的锁定快照与历史算法重放结果不一致。`);
    }
    let selected = matching[0];
    if (matching.length > 1) {
      const firstSignature = matching[0].stateSignature;
      if (!matching.every(outcome => isDeepStrictEqual(outcome.stateSignature, firstSignature))) {
        throw new Error(`结算记录 ${original.id} 可匹配多个算法版本，但结算后状态不同，请人工确认。`);
      }
      selected = matching.find(outcome =>
        outcome.record.algorithmVersion === CURRENT_SETTLEMENT_VERSION
      ) || matching[0];
    }

    if (explicitVersion === null) migratedCount += 1;
    processedRecords.push({
      ...clone(original),
      algorithmVersion: selected.record.algorithmVersion
    });
  }

  return {
    ledger: {
      version: 1,
      records: processedRecords,
      ...(Number.isSafeInteger(ledger.lastEventSequence) && ledger.lastEventSequence > 0
        ? { lastEventSequence: ledger.lastEventSequence }
        : {})
    },
    migrated: migratedCount > 0,
    migratedCount,
    settlementCount
  };
}

module.exports = {
  SUPPORTED_SETTLEMENT_VERSIONS,
  activeSettlementRecords,
  mergeSettlementLedger,
  migrateSettlementLedger
};
