# License server API

All endpoints use HTTPS and JSON. Errors are `{ "error": "<code>", "message": "<readable text>" }` with a 4xx/5xx status. Plain HTTP gets `400 https_required` ("HTTPS is required").

## Public endpoints (applications)

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /v1/health` | | `{ status: "ok", version, time }` |
| `GET /v1/keyring` | | the public keyring |
| `POST /v1/activations` | `licenseKey, productId, deviceId, deviceName?, os?, appVersion?` | `201 { activationId, activationSecret, certificate, license }` |
| `POST /v1/activations/refresh` | `activationId, activationSecret, appVersion?` | `{ certificate, license }`; `410 activation_released` when support released the computer; `403 license_*` when the license no longer works |
| `POST /v1/activations/release` | `activationId, activationSecret` | `{ released: true, transfersRemaining }` (self-service transfer) |
| `POST /v1/trials` | `productId, deviceId, planCode?, deviceName?, os?, appVersion?` | same as an activation; `403 trial_denied` on a second trial |

Failed activations count per IP address; after `LMP_ACTIVATION_FAILURE_LIMIT` failures within the window, the address gets `429 too_many_attempts`.

## Admin endpoints (EspoCRM)

Only from `LMP_ADMIN_ALLOWED_IPS` (`403 address_not_allowed`, "Not allowed from this address"), and every request is signed:

```
Authorization: LMP-HMAC client=<id>, ts=<unix seconds>, nonce=<random hex>, sig=<base64url>
sig = HMAC-SHA256(secret, METHOD + "\n" + PATH_WITH_QUERY + "\n" + ts + "\n" + nonce + "\n" + hex(SHA256(body)))
```

Requests older than 5 minutes or with a reused nonce are refused. Mutating requests may carry `Idempotency-Key`: a repeat returns the first answer with `replayed: true` and without keys.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/admin/status[?fresh=1]` | connection check, audit chain (`intact`/`broken`), signing key, database generation, counts |
| `PUT /v1/admin/applications/{productId}` | register or update an application |
| `PUT /v1/admin/applications/{productId}/plans/{planCode}` | create or update a plan (`409 plan_locked` when changing the type of a plan with licenses) |
| `POST /v1/admin/licenses/issue` | `productId, planCode, quantity, customer?{id,name}, contactId?, order?{ref,itemId}, grantReason?, actor?`; with an order line only missing licenses are issued; keys are in the answer once |
| `GET /v1/admin/licenses/{id or reference}` | license with its device activations |
| `GET /v1/admin/licenses/{id}/audit` | audit history of a license |
| `POST /v1/admin/licenses/{id}/{operation}` | `suspend`, `reactivate`, `revoke`, `extend` (`value`+`unit` or `expiresAt`), `renew` (`periods`), `cancel-subscription` (`atPeriodEnd`), `replace-key`, `recover` (`activationIds`, `replaceKey`), `release-all`; most need `reason` |
| `POST /v1/admin/activations/{id}/release` | `reason, assisted` |
| `GET /v1/admin/changes?since=&auditSince=&limit=` | everything changed since a revision: `licenses`, `activations`, `audit`, `nextSince`, `nextAuditSince`, `more`, `instanceId`, `generation` |
