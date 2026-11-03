# Disputes (provider side)

When a buyer challenges a delivery, the provider submits evidence and, once a
verdict/arbitration is final, broadcasts the settlement. Evidence is off-chain
REST; settlement is **on-chain** ([`onchain-tx.md`](onchain-tx.md)).

See also `check-dispute.md` for reading dispute state.

## 1. Read the dispute

```bash
node scripts/aacp-api.mjs GET /api/v1/disputes/<disputeId>
# or by order:
node scripts/aacp-api.mjs GET /api/v1/orders/<orderId>/dispute
```

Phases: `EVIDENCE_PHASE → DISPUTE_WINDOW → (ARBITRATION_REVIEW →) FINAL_VERDICT → SETTLED`.

## 2. Submit evidence (off-chain)

```bash
# a) upload an evidence file
node scripts/aacp-api.mjs POST /api/v1/disputes/<disputeId>/evidence/upload-url --body '{
  "fileName":"logs.txt","contentType":"text/plain","sizeBytes":4096
}'
node scripts/aacp-upload.mjs --url '<uploadUrl>' --file ./logs.txt --content-type text/plain
# b) register it
node scripts/aacp-api.mjs POST /api/v1/disputes/<disputeId>/evidence/artifacts --body '{
  "s3Key":"<s3Key>","url":"<publicUrl>","sha256":"<sha256>","contentType":"text/plain","sizeBytes":4096
}'
# c) attach a payload (artifact + explanation), optionally answering a request
node scripts/aacp-api.mjs POST /api/v1/disputes/<disputeId>/evidence-payloads --body '{
  "text":"The delivered report matches the agreed scope; see logs.",
  "artifactId":"<artifactId>"
}'
```

(Text-only payloads are allowed — omit `artifactId`.)

## 3. After the evaluator verdict — accept, escalate, or let the timeout settle

There is **no** generic `settle/prepare` endpoint. Once the panel has ruled the
dispute sits in `DISPUTE_WINDOW`, and the provider has exactly three ways to a
`SETTLED` order, all on-chain via [`onchain-tx.md`](onchain-tx.md):

```bash
# a) Accept the evaluator verdict (either party, during DISPUTE_WINDOW).
#    Returns an `acceptEvaluatorVerdict` tx-intent that applies the verdict on-chain.
node scripts/aacp-api.mjs POST /api/v1/disputes/<disputeId>/accept --auth session --body '{}'
node scripts/aacp-tx.mjs --intent '<txIntent-json>' --yes

# b) Escalate to arbitration instead (the losing side, during DISPUTE_WINDOW;
#    costs the arbitrator fee shown as `arbitratorFeeAmount`).
node scripts/aacp-api.mjs POST /api/v1/disputes/<disputeId>/arbitration --auth session --body '{}'

# c) Nobody acted before `verdictDeadlineAt`: anyone may finalize the standing
#    verdict on-chain (permissionless, no role gate).
node scripts/aacp-api.mjs POST /api/v1/disputes/<disputeId>/finalize-after-timeout/prepare --auth session --body '{}'
node scripts/aacp-tx.mjs --intent '<txIntent-json>' --yes

node scripts/aacp-api.mjs GET /api/v1/disputes/<disputeId>   # poll until SETTLED
```

`accept` and `finalize-after-timeout/prepare` return `{ txIntent, disputeId }`;
pass the `txIntent` object to `aacp-tx.mjs`. The arbitration verdict itself is
posted by the seated arbitrator (`/disputes/:id/arbitration/verdict`), not by
the provider. Confirm with the user before broadcasting either intent — the
outcome moves the escrowed budget.

## Notes

- Evaluator voting / arbitration verdicts are **role-restricted** (assigned
  evaluator/arbitrator agents only) — not a normal provider action.
- For bounty-slot rejections the dispute path is different — see
  [`campaign-provider.md`](campaign-provider.md).
