// Run with every server using these ledgers stopped. Storage acquires each
// ledger's existing single-writer lease; never bypass or delete a live lease.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const storage = require('../lib/storage');
const { generateMemberId } = require('../lib/member-id');
const { migrateMemberIdentifiers, renameMemberIdentifiers } = require('../lib/member-identifiers');
const mapIndex = process.argv.indexOf('--mapping');
const explicitMappings = mapIndex < 0 ? null : JSON.parse(fs.readFileSync(process.argv[mapIndex + 1], 'utf8'));
const root = path.dirname(storage.DB_FILE);
const stores = [{ id: 'default', store: storage }];
try {
  for (const id of fs.readdirSync(root).filter(name => /^ledger-[1-9][0-9]*$/.test(name))) {
    const dir = path.join(root, id);
    if (!fs.existsSync(path.join(dir, 'ledger.json'))) continue;
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('账本目录不能为符号链接。');
    stores.push({ id, store: storage.createStorage({ dataDir: dir, backupDir: path.join(storage.BACKUP_DIR, id) }) });
  }
  const archiveDir = path.join(storage.BACKUP_DIR, 'member-id-migration-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(archiveDir);
  // Keep byte-for-byte originals outside normal rotating backups.
  for (const { id, store } of stores) {
    const zip = new AdmZip();
    for (const file of ['db.json', 'config.json', 'settlements.json']) {
      const source = path.join(path.dirname(store.DB_FILE), file);
      if (fs.existsSync(source)) zip.addFile('data/' + file, fs.readFileSync(source));
    }
    store.atomicWriteFile(path.join(archiveDir, id + '.zip'), zip.toBuffer());
  }
  // Validate every ledger before committing any migration.
  const used = new Set(stores.flatMap(({ store }) => store.readDb().members.map(member => member.id)));
  const plans = stores.map(({ id, store }) => ({ id, store,
    result: explicitMappings ? renameMemberIdentifiers(store.readDb(), store.readSettlements(), explicitMappings[id] || {})
      : migrateMemberIdentifiers(store.readDb(), store.readSettlements(), () => generateMemberId(used)) }));
  storage.atomicWriteFile(path.join(archiveDir, 'member-id-map.json'), JSON.stringify(
    Object.fromEntries(plans.map(({ id, result }) => [id, result.mapping])), null, 2));
  for (const { id, store, result } of plans) {
    if (result.migrated) store.writeSnapshot(result.db, store.readConfig(), result.ledger);
    console.log(`${id}: ${Object.keys(result.mapping).length} member IDs migrated; replay verified`);
  }
  console.log('Original backups: ' + archiveDir);
} finally {
  for (const { store } of stores.reverse()) store.releaseDataDirectoryLock();
}
