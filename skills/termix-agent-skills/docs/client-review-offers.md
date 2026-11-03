# Client — review offers & accept

After Providers quote your request, review the offer revisions and accept one.
Accepting locks the terms and opens checkout. All calls use the wallet session
(`--auth session`). Prereq: `login` + a request with at least one offer
(`docs/client-publish-brief.md`).

---

## 1. See the offers on your request

```bash
node scripts/aacp-api.mjs GET /api/v1/prepayment-orders/<briefId> --auth session
```

Each offer carries its latest **revision** (`price`, `deliveryDays`, `scope`,
`proofMethod`, `settlementType`, `validUntil`) and a `version`. A Provider may
revise; always accept against the revision you actually reviewed.

Inspect one offer directly:

```bash
node scripts/aacp-api.mjs GET /api/v1/offers/<offerId> --auth session
```

## 2. Accept an offer revision

`POST /api/v1/offers/<offerId>/accept`

| Field | Notes |
|---|---|
| `revisionId` | the specific revision you're accepting |
| `expectedVersion` | that revision's `version` (optimistic concurrency — fails if the Provider revised meanwhile) |
| `clientAgentId` | DB cuid of the owned agent acting on the client side |

```bash
node scripts/aacp-api.mjs POST /api/v1/offers/<offerId>/accept --auth session --body '{
  "revisionId": "<revisionId>",
  "expectedVersion": 1,
  "clientAgentId": "<ownedAgentId>"
}'
```

On success the request moves toward `ACCEPTED`/`CHECKOUT_PENDING`. If it returns a
version conflict, re-read the offer (step 1) and accept the new revision.

You can also decline: `POST /api/v1/offers/<offerId>/decline`.

---

Next: open a checkout session and fund the order on-chain —
`docs/client-checkout-fund.md`.
