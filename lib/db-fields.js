/**
 * Pure helper for stripping transient/cached fields before persisting or exporting core `db.json`.
 */
const TRANSIENT_DB_FIELDS = ['indexCache', 'customBenchmarkCache', 'marketHistory', 'cnhRate'];

function stripTransientDbFields(dbData) {
  const coreDb = JSON.parse(JSON.stringify(dbData));
  for (const field of TRANSIENT_DB_FIELDS) {
    delete coreDb[field];
  }
  return coreDb;
}

module.exports = {
  TRANSIENT_DB_FIELDS,
  stripTransientDbFields
};
