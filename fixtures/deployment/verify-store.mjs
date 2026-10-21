import { DatabaseSync } from 'node:sqlite';

// Independent of the deployed auction code/metrics. Compare retained business
// rows against accepted request receipts as well as the auction invariants.
export function verifyAuctionStore(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const state=JSON.parse(db.prepare('SELECT payload FROM auction_state WHERE id=1').get().payload),requests=db.prepare('SELECT * FROM auction_requests').all();
    const violations=new Set(),actual=new Map(),accepted=new Map();
    const key=(lot,bid)=>JSON.stringify([lot,bid.amountCents,bid.dealer,bid.at]);
    const increment=(map,id)=>map.set(id,(map.get(id)||0)+1);
    for(const lot of state.lots)for(const bid of lot.bids) {
      increment(actual,key(lot.id,bid));
      if(bid.amountCents>lot.currentBidCents)violations.add('WINNING_BID_REGRESSED');
      if(bid.at>=lot.endsAt)violations.add('BID_ACCEPTED_AFTER_CLOSE');
    }
    let acceptedBids=0;
    for(const row of requests) {
      const result=JSON.parse(row.result);if(result.status!==201)continue;acceptedBids++;
      const [lotId,amount,dealer]=JSON.parse(row.fingerprint),bid=result.lot?.bids?.at(-1);
      if(!bid||bid.amountCents!==amount||bid.dealer!==dealer||result.lot.id!==lotId){violations.add('ACCEPTED_RECEIPT_MISMATCH');continue;}
      increment(accepted,key(lotId,bid));
    }
    if([...new Set([...actual.keys(),...accepted.keys()])].some(id=>actual.get(id)!==accepted.get(id)))violations.add('ACCEPTED_BID_LEDGER_MISMATCH');
    const {count:operatorActions}=db.prepare('SELECT COUNT(*) AS count FROM auction_operator_audit').get();
    return {violations:[...violations].sort(),acceptedBids,retainedBids:[...actual.values()].reduce((sum,n)=>sum+n,0),requestReceipts:requests.length,operatorActions,observedAt:Date.now()};
  } finally {db.close();}
}
