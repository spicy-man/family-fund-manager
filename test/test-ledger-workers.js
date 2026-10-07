const assert=require('assert');
const fs=require('fs'), os=require('os'), path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'fund-ledger-workers-'));
process.env.FUND_DATA_DIR=path.join(root,'data');
process.env.FUND_BACKUP_DIR=path.join(root,'backups');
process.env.FUND_EXTERNAL_SYNC='0';
const yahoo=require('../lib/yahoo');
const pending=[];
yahoo.fetchYahooPrices=(ticker,start)=>new Promise(resolve=>pending.push({ticker,start,resolve}));
const {createLedgerApplication,ensureIndexCache}=require('../server');
const storage=require('../lib/storage');
const second=createLedgerApplication(storage);
const turn=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
try {
  const first=ensureIndexCache(['2026-03-03']);
  const later=second.ensureIndexCache(['2025-03-03']);
  await turn();
  assert.strictEqual(pending.length,2,'only one shared benchmark job may fetch at a time');
  for(const item of pending.splice(0)) item.resolve({'2026-03-02':100});
  await first; await turn();
  assert.strictEqual(pending.length,2);
  for(const item of pending.splice(0)) item.resolve({'2025-03-02':90,'2026-03-02':100});
  await later;
  const history=storage.readMarketHistory();
  assert.strictEqual(history.tickers.VOO.prices['2025-03-02'],90);
  assert.strictEqual(history.tickers.VOO.prices['2026-03-02'],100);
  // Each route registration receives the same worker state but separate closures.
  const {registerTickerRoutes}=require('../routes/tickers');
  const shared={};let fetches=0, finish;
  let cache={version:1,tickers:{},updatedAt:null};
  const deps={tickerRefreshState:shared,now:()=>new Date(),readConfig:()=>({tickers:[{ticker:'VOO'}]}),
    writeConfig:()=>{},readTickerCache:()=>JSON.parse(JSON.stringify(cache)),writeTickerCache:value=>{cache=value},
    fetchTickerAthData:()=>{fetches++;return new Promise(resolve=>{finish=resolve})}};
  const fakeApp=()=>({get:()=>{},post:()=>{}});
  const a=registerTickerRoutes(fakeApp(),deps),b=registerTickerRoutes(fakeApp(),deps);
  const job=a.queueTickerRefresh(deps.readConfig());
  const duplicate=b.queueTickerRefresh(deps.readConfig());
  assert.strictEqual(job,duplicate);
  assert.strictEqual(fetches,1);
  finish({VOO:{ticker:'VOO',priceBasis:'adjusted-close',regularClose:100}});
  await job;
  assert.strictEqual(cache.tickers.VOO.regularClose,100);
  console.log('Cross-ledger benchmark serialization and ticker worker deduplication passed.');
}finally{
 storage.releaseDataDirectoryLock();
 fs.rmSync(root,{recursive:true,force:true});
}
})().catch(error=>{console.error(error);process.exitCode=1});
