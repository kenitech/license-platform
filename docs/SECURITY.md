# Security: what offline licensing can and cannot enforce

## What is protected

- **Keys are never stored.** The server keeps `HMAC-SHA256(pepper, key)`; EspoCRM keeps only the last 4 characters. A stolen database alone does not reveal keys, and keys cannot be tested against it without the peppers.
- **Activations are signed.** Each computer receives a certificate signed with Ed25519. Applications verify it offline with the public keyring; changing any field (expiry, entitlements, device) breaks the signature. The private key never leaves `/etc/lmp/keys` (mode 600; the server refuses to start if other users can read it).
- **Certificates are bound to one computer** through a hash of its device identifier. Copying the license file to another computer does not work.
- **Each activation has its own secret.** Refreshing or releasing an activation needs it, so knowing a license reference is not enough to release someone's computer.
- **The audit log is a hash chain.** Every entry includes the hash of the previous one, and each license's current state must match the digest recorded in its latest entry. Editing, deleting or inserting rows, or changing a license directly in the database, shows as **audit chain broken**.
- **The admin API** accepts only signed requests (HMAC with a shared secret that is never transmitted), only from allowed addresses, within 5 minutes, without replays, over HTTPS.
- **Guessing is throttled.** Addresses with repeated failed activations are blocked for a while, and failures are recorded in the audit log.
- **One trial per computer and application**, recorded by device hash.

## What cannot be enforced

- **A computer that never goes online again** cannot be told that its license was revoked, suspended or released. With the Perpetual offline policy, a lifetime license keeps working there forever. Use the Periodic offline policy ("confirm online every N days") when revocation must reach every computer; the application then stops after N days without contact.
- **The local clock** decides offline expiry. The SDK detects a clock moved back more than a day since the last check and then requires going online, but a user who sets the clock back before the first check can extend a fixed term while offline. Offline grace periods are a convenience, not a guarantee.
- **A modified application** can skip the license check entirely. Signing proves a certificate is genuine; it cannot force code to check it. Obfuscation, code signing and server-side features raise the cost of cracking but do not prevent it.
- **Device identifiers** come from the operating system (machine-id, IOPlatformUUID, MachineGuid). Virtual machines can be cloned with the same identifier.
- **Shared keys**: anyone holding a key can activate it up to the device limit. Device limits and Replace License Key contain the damage.

## Secrets to protect

| File | If lost | If leaked |
| --- | --- | --- |
| `/etc/lmp/keys/<kid>.key.pem` | Existing activations keep working; generate a new key and rotate | Anyone can mint certificates: rotate immediately and ship a keyring without the leaked key |
| `/etc/lmp/secrets/key-peppers` | **Every existing license key becomes unusable** | Keys can be tested offline against a stolen database |
| `/etc/lmp/secrets/admin-clients.json` / the CRM secret | Create a new one (OPERATIONS.md) | Anyone at an allowed address can issue licenses: rotate the secret |

Keep encrypted offline copies of `/etc/lmp/keys` and `/etc/lmp/secrets`.
