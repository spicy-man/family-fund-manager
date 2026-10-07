const { generateMemberId } = require('./member-id');
const { isDeepStrictEqual } = require('util');
const { calculateStateFromDb } = require('./calculator');
const { mergeSettlementLedger, migrateSettlementLedger } = require('./settlement-ledger');

const MEMBER_ID_PATTERN = /^[1-9][0-9]{5}$/;
const referenceFields = new Set(['member', 'fromMember', 'toMember', 'gpMember', 'gpMemberId']);
const mapped = (mapping, id) => Object.hasOwn(mapping, id) ? mapping[id] : id;
const clone = value => JSON.parse(JSON.stringify(value));

// Only rewrite structured references. Names, remarks, transaction IDs and lot
// source IDs are historical data, even if their text equals a member ID.
function remapReferences(value, mapping) {
  if (Array.isArray(value)) return value.map(item => remapReferences(item, mapping));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    referenceFields.has(key) ? mapped(mapping, item)
      : key === 'lpMembers' && Array.isArray(item) ? item.map(id => mapped(mapping, id))
        : remapReferences(item, mapping)
  ]));
}

function migrateMemberIdentifiers(db, ledger, generateId = used => generateMemberId(new Set(used))) {
  const mapping = {};
  const used = new Set(db.members.map(member => member.id));
  if (used.size !== db.members.length) throw new Error('成员编号重复，不能安全迁移。');
  for (const member of db.members) {
    if (!['me', 'mother', 'father'].includes(member.id) && !/^mem_[0-9a-f-]{36}$/i.test(member.id)) continue;
    const id = generateId(used);
    if (!MEMBER_ID_PATTERN.test(id) || used.has(id)) throw new Error('生成的成员编号无效或重复。');
    used.add(id);
    mapping[member.id] = id;
  }
  if (!Object.keys(mapping).length) return { db: clone(db), ledger: clone(ledger), mapping, migrated: false };
  return renameMemberIdentifiers(db, ledger, mapping);
}

function renameMemberIdentifiers(db, ledger, mapping) {
  // Validate the existing locked snapshots before translating them.
  migrateSettlementLedger(db, ledger);
  const nextDb = remapReferences(db, mapping);
  nextDb.members = db.members.map(member => ({ ...clone(member), id: mapped(mapping, member.id) }));
  if (new Set(nextDb.members.map(member => member.id)).size !== nextDb.members.length) {
    throw new Error('同一账本内成员编号不能重复。');
  }
  const nextLedger = remapReferences(ledger, mapping);
  migrateSettlementLedger(nextDb, nextLedger);
  const before = remapReferences(calculateStateFromDb(mergeSettlementLedger(clone(db), clone(ledger))), mapping);
  for (const key of ['members', 'memberHistory', 'memberHighWaterHistory', 'memberPotentialFees']) {
    const container = key === 'members' ? before : before.charts;
    container[key] = Object.fromEntries(Object.entries(container[key] || {}).map(([id, value]) => [mapped(mapping, id),
      value]));
  }
  const after = calculateStateFromDb(mergeSettlementLedger(clone(nextDb), clone(nextLedger)));
  if (!isDeepStrictEqual(before, after)) throw new Error('成员编号迁移改变了历史计算结果，已中止。');
  return { db: nextDb, ledger: nextLedger, mapping, migrated: true };
}

module.exports = { MEMBER_ID_PATTERN, remapReferences, migrateMemberIdentifiers, renameMemberIdentifiers };
