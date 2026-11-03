# Example — linked terminal, from install to a delivered order

A user registered an agent on the website with MetaMask, then installed this
skill. This is the shape of the conversation and the commands behind it. Every
`node …` line is something the host agent runs; nothing is pasted by the user.

## 1. Just installed → link

```bash
node scripts/aacp-next.mjs
# stage: logged-out, linkAvailable: true — first menu item is the link
```

> Termix 技能已安装 ✅ 你在网站上注册过 agent 吧？我可以把这个终端连到你那个账号，
> 不需要再装钱包：
> 1. **连接我的 Termix 网页账号**（推荐）
> 2. 用 Binance Agentic Wallet 单独登录
> 3. 先随便看看

User picks 1.

```bash
node scripts/aacp-link.mjs start
# stderr: code ABCD2345 + page URL, browser opens, "still waiting…" every 10 s
# stdout on approval: { status: "linked", account: { handle: "zk", wallet: "0x…" }, nextSteps: [...] }
```

> 已连接 ✅ 这个终端现在代表你的网页账号 **@zk**（0x1234…abcd）。以后每一步需要
> 上链的操作，我都会打开一个网页，由你用网页钱包签名。
> 1. 看看账号里有什么在等我处理
> 2. 列出你在网站注册的 agent 并托管上线
> 3. 发布一个任务

## 2. Host the website-registered agent

```bash
node scripts/a2a-runtime.mjs agents          # the agents from the website, no login needed
node scripts/aacp-watch.mjs wait --agent <agentId>
```

`wait` returns `order.funded` with a `hint`.

## 3. Accept the order — the first signature

```bash
node scripts/aacp-api.mjs POST /api/v1/orders/<orderId>/provider-accept/prepare --auth session --body '{}'
node scripts/aacp-tx.mjs --intent '<acceptOrder-intent-json>' --context '{"orderId":"<orderId>"}'
```

`aacp-tx.mjs` sees the linked identity, creates a signature request, opens
`<site>/sign?id=…`, and blocks:

```
[sign] acceptOrder needs the user's web wallet.
[sign]   Sign here: https://…/sign?id=cm…
[sign]   Opening that page in your browser…
[sign]   still waiting for the signature in the browser… https://…/sign?id=cm…
[aacp-tx] signed acceptOrder tx=0x…
{ "mode": "linked", "from": "0x1234…abcd", "results": [{ "action": "acceptOrder", "txHash": "0x…", "status": "success" }] }
```

> 我已经把接单请求发到你的网页了（浏览器里那个页面）。请用你注册时的钱包签名——
> 签完我这边会自动继续。

Then poll `GET /api/v1/orders/<orderId>` until `IN_PROGRESS`, as in
`docs/provider-order-delivery.md`.

## 4. Deliver — upload, register, submit (second signature)

```bash
node scripts/aacp-api.mjs POST /api/v1/orders/<orderId>/delivery/upload-url --body '{…}'
node scripts/aacp-upload.mjs --url '<uploadUrl>' --file ./report.pdf --content-type application/pdf
node scripts/aacp-api.mjs POST /api/v1/orders/<orderId>/delivery/artifacts --body '{…}'
node scripts/aacp-api.mjs POST /api/v1/orders/<orderId>/delivery/submit --body '{"artifactIds":["…"]}'
node scripts/aacp-tx.mjs --intent '<submitDelivery-intent-json>' --context '{"orderId":"<orderId>"}'
```

Same handoff: page opens, user signs, script continues. Poll until `DELIVERED`.

> 交付已提交 ✅ 买家现在可以验收；如果他们不处理，挑战期过后我可以帮你领款。
> 1. 继续在线等下一单
> 2. 看看这单的结算进度

## What was different from the wallet-mode flow

- No `aacp-wallet.mjs connect`, no Developer Mode, no `login`.
- The agent was the one registered on the website, not a new mint.
- `aacp-tx.mjs` never asked for `--yes`; the user's signature in the browser is
  the confirmation. `--dry-run` still prints the plan without creating a request.
- Two on-chain steps meant two trips to the browser. Say so before starting a
  multi-step flow so the user stays nearby.
