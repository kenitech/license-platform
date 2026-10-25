# Operations

Commands run on the license server in `/opt/lmp/license-server` after loading the settings:

```sh
set -a; . /etc/lmp/license-server.env; set +a
```

## Support playbook

| Customer says | Where | Do |
| --- | --- | --- |
| "I have a new computer, the old one works" | in the app | The customer clicks **Transfer to another computer** on the old one and activates the same key on the new one. Self-service transfers follow the plan's Transfer Policy. |
| "My computer was lost, stolen or died" | License | **Recover (Lost Device)**: tick the lost computer, give a reason, tick **Also replace the license key** if the key may be misused, then send the new key. |
| "Transfer limit reached" / "Device limit reached" | Device Activation | **Assisted Transfer** (or **Release Device**). Support transfers ignore the yearly limit and the Not transferable policy. |
| "I lost my key" | License | **Replace License Key**. The old key stops working for new activations; computers already activated keep working. |
| "I need more time" | License | **Extend** (fixed-term and trial) by a number of days/months/years or to a new date. |
| "I paid for another period" | License | **Renew** with the number of periods. Within the payment grace period the new period continues the old one. |
| "Cancel my subscription" | License | **Cancel Subscription**. Keep **keep it working until the end of the paid period** ticked unless the customer must lose access now. |
| Payment dispute | License | **Suspend**, later **Reactivate**. |
| Refund, chargeback, abuse | License | **Revoke**. **Reactivate** undoes it. |
| "Nothing works, start over" | License | **Release All Devices**. The customer activates again. |

Suspend, revoke and releases take effect when the computer next contacts the server. A lifetime license on a perpetual-offline application keeps working on a computer that never goes online again (see SECURITY.md).

## Backups

- `lmp-backup.timer` runs `node bin/backup.js create` every hour into `/var/backups/lmp` and keeps `LMP_BACKUP_KEEP` copies (default 168, one week).
- Weekly: `systemctl list-timers lmp-backup.timer`, then `node bin/backup.js verify /var/backups/lmp/<newest>.db` must print `"ok": true`. It checks SQLite integrity and the audit chain.
- Copy backups off the server (another machine or cloud storage), together with an offline copy of `/etc/lmp/keys` and `/etc/lmp/secrets`. **Without the peppers in `/etc/lmp/secrets/key-peppers`, no existing license key can be recognized.**

### Restore

```sh
sudo systemctl stop lmp-license-server
node bin/backup.js restore /var/backups/lmp/<chosen>.db   # keeps the current database as license.db.pre-restore-<time>
sudo systemctl start lmp-license-server
```

Then in EspoCRM, **Administration → License Manager → Run Sync Now**. The restore raised the database *generation*, so EspoCRM rebuilds its mirror; licenses sold after the backup are marked **Missing on server** and their orders go back to **Partially Issued**. Click **Issue Licenses** on those orders and send the new keys.

Run `restore` as root or as `lmp`; when run as root the restored files are given to the owner of the data folder.

## Rotate the signing key (every 1 to 2 years)

1. `node bin/keys.js generate prod-2027-10`
2. `node bin/keys.js export-public prod-2026-10`: the keyring now trusts both keys, the old one still signs.
3. Give `public-keyring.json` to the developers and release application updates containing it.
4. When most customers have updated: `node bin/keys.js export-public prod-2027-10`, set `LMP_SIGNING_KID=prod-2027-10` in `/etc/lmp/license-server.env`, `sudo systemctl restart lmp-license-server`.
5. **Administration → License Manager** shows the new signing key. Existing activations keep working; computers get certificates signed with the new key at their next refresh.

Keep old public keys in `/etc/lmp/keys` until no application version that needs them is in use.

## Change the CRM secret

1. Add a second entry to `/etc/lmp/secrets/admin-clients.json`, for example `{"id":"espocrm-2027","secret":"<new>","roles":["crm"]}`, then `sudo systemctl reload lmp-license-server` (reload re-reads the clients; restart also works).
2. In EspoCRM: `php command.php config:set licenseManagerClientId espocrm-2027` and `... licenseManagerClientSecret '<new>'`. Check the connection shows OK.
3. Remove the old entry and reload again.

## Add a key pepper

Add a new line **at the top** of `/etc/lmp/secrets/key-peppers` (`p2:<base64 secret>`) and restart. New keys use the first pepper; all peppers are tried for existing keys. Never remove a pepper while licenses issued with it exist.

## Certificates

The deploy hook copies renewed certificates to `/etc/lmp/tls/` and runs `systemctl reload`, which switches certificates without dropping connections. The server also checks the files every 5 minutes. The journal shows `tls certificate reloaded`, or `tls certificate reload failed` (the old certificate stays in use) when the new certificate and key do not match.

## Watching for problems

- **Administration → License Manager** must show **OK** and **audit chain intact**. *Broken* means the database was changed outside the server (for example a license row edited by hand): restore from a backup and investigate.
- **Licensing → License Audit → Failed activations and denied trials**: many in a short time from one address suggest key guessing or trial abuse. The server already blocks an address after 10 failures in 10 minutes (`LMP_ACTIVATION_FAILURE_LIMIT`, `LMP_ACTIVATION_FAILURE_WINDOW_SECONDS`).
- Logs: `journalctl -u lmp-license-server` (one JSON object per line).
