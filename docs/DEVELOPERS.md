# Adding licensing to an application

You need two things from the license administrator:

- the **Product Identifier** of your application (for example `acme-editor`), and
- `public-keyring.json`, created with `node bin/keys.js export-public <key>`. It contains public keys only.

Ship both inside the application. Never ship anything from `/etc/lmp/keys` or `/etc/lmp/secrets`.

## Node.js / Electron

Copy `packages/lmp-core` and `packages/lmp-client` into your project, keeping them side by side. They have no dependencies.

```js
import fs from 'node:fs';
import path from 'node:path';
import { LicenseClient } from './vendor/lmp-client/src/index.js';

const client = new LicenseClient({
  serverUrl: 'https://licenses.example.com',
  productId: 'acme-editor',
  keyring: JSON.parse(fs.readFileSync(path.join(__dirname, 'public-keyring.json'), 'utf8')),
  storage: LicenseClient.fileStorage(path.join(app.getPath('userData'), 'license.json')),
  appVersion: app.getVersion(),
});

// At startup: refreshes online when possible, otherwise decides offline.
const state = await client.checkOnline();
if (!state.valid) showActivationScreen(state);

// Activation screen
await client.activate(keyTypedByUser);   // throws LicenseError with .code and a readable .message
await client.startTrial();              // free trial, one per computer, no key

// Features
if (client.hasEntitlement('pro')) enableProFeatures();

// "Transfer to another computer"
await client.transfer();
```

`check()` / `checkOnline()` return `{ valid, state, mustGoOnline, entitlements, expiresAt, reference, type }`.

| state | meaning | what the app should do |
| --- | --- | --- |
| `active` | license works | run; if `mustGoOnline`, an online check is due within 7 days |
| `offline_grace` | the term ended but the computer could not confirm a renewal; still valid | run, and ask the user to connect |
| `check_required` | the application's offline policy requires an online confirmation now | ask the user to connect |
| `expired`, `revoked`, `suspended`, `cancelled` | license does not work | show the reason, offer to enter another key |
| `not_activated` | no activation on this computer (or it was released) | show the activation screen |
| `invalid_certificate`, `clock_tampered` | the stored activation is not valid on this computer, or the clock was moved back | ask the user to connect / activate again |

Error codes from `activate`, `startTrial` and `transfer` include `invalid_key`, `wrong_product`, `device_limit_reached`, `trial_denied`, `transfer_limit_reached`, `transfer_not_allowed`, `license_revoked`, `license_suspended`, `license_expired`, `too_many_attempts` and `network_error`.

## Other languages

Any language can verify certificates offline. A certificate is `lmp1.<payload>.<signature>`:

- `payload` is base64url of a JSON object; `signature` is base64url of an Ed25519 signature over the ASCII text `lmp1.<payload>`.
- Pick the key from the keyring whose `kid` equals `payload.kid` (the public key is SPKI PEM).
- Check `payload.pid` is your Product Identifier and `payload.dev` is `hex(sha256("lmp-dev:" + deviceId))` for this computer.
- `lexp` (unix seconds or null) is when the license stops working; `ogr` is the offline grace in seconds after `lexp`; `chk` (or null) is the deadline for the next online confirmation; `ent` is the list of entitlements.

The HTTP calls are in [API.md](API.md).

## Key rotation

When the administrator rotates the signing key, they give you a new `public-keyring.json` that trusts both keys. Release an update containing it **before** they switch, so customers' applications accept certificates signed with the new key.
