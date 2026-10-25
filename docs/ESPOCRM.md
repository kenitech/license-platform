# EspoCRM extension

`license-manager-<version>.zip`, for EspoCRM 9.0 or later (PHP 8.2+ with curl). Install it in **Administration → Extensions → Upload**.

## What it adds

| Tab (Licensing group) | Entity | Notes |
| --- | --- | --- |
| Applications | `LmApplication` | Saved to the license server first. The Product Identifier can never change. |
| License Plans | `LmLicensePlan` | Saved to the server first. Type and code are locked once licenses exist; archive and create a new plan instead. |
| License Orders | `LmLicenseOrder` | With a Purchased Products panel (`LmOrderItem`). Amount is computed. **Issue Licenses** at the top. |
| Licenses | `LmLicense` | Read-only mirror of the server, refreshed every 5 minutes. Actions in the dropdown next to Edit. |
| Device Activations | `LmDeviceActivation` | Read-only mirror. **Assisted Transfer**, **Release Device**. |
| License Audit | `LmLicenseAudit` | Read-only mirror of the server's audit chain. |

Accounts get a **Licensing** tab with their licenses, orders and devices (the installer adds it to the Account layout and keeps any customization). Contacts get a Licenses panel. A **License Summary** dashlet and an **Administration → License Manager** page are added.

## Settings

Set on the EspoCRM server with `php command.php config:set <name> <value>`:

| Setting | Meaning |
| --- | --- |
| `licenseManagerServerUrl` | `https://licenses.example.com` |
| `licenseManagerClientId` | the `id` in `/etc/lmp/secrets/admin-clients.json` |
| `licenseManagerClientSecret` | its `secret`. Stored in `data/config-internal.php`, never sent to browsers |
| `licenseManagerIssueRequires` | `paid_or_approved` (default) or `paid` |
| `licenseManagerTimeout` | seconds per request to the license server (default 20) |

## Permissions

In **Administration → Roles**:

- **Licenses**, **Device Activations**, **License Audit**: *read* for support staff (these scopes only offer read).
- **License Orders** and **Purchased Products**: create/edit for sales staff. **Applications** and **License Plans**: for the people who manage the catalog.
- **License Operations**: *enabled* only for people allowed to issue, revoke, suspend, extend, renew, cancel, replace keys, recover, release devices, and to set Administrative Approval on orders.

## How changes flow

- Applications and plans: saving sends the record to the server first. If the server refuses or cannot be reached, the error is shown and nothing is saved. Records saved before the connection was configured stay **Pending**; open them and click **Sync to License Server**.
- Licenses and devices: every action calls the server first and then updates the mirror. The scheduled job **License Manager: Sync with License Server** pulls all other changes (activations from customers' computers, trials, expiries) every 5 minutes. It needs EspoCRM's cron. **Refresh from Server** on a license updates it immediately.
- After a server restore, the next sync rebuilds the mirror and marks licenses the server no longer has as **Missing on server**.
- Keys are never stored in EspoCRM: only the last 4 characters, for searching.

## Troubleshooting

| Message | Fix |
| --- | --- |
| The license server connection is not configured | Run the three `config:set` commands. |
| The license server rejected the CRM credentials | Client id or secret differs from `admin-clients.json`. Re-enter both; reload the server if you edited the file. |
| The license server did not confirm the operation | Server down or unreachable: check `/v1/health` and `systemctl status lmp-license-server`. Retrying is safe. |
| Not allowed from this address | Add the EspoCRM server's IP to `LMP_ADMIN_ALLOWED_IPS` and restart the license server. |
| The request time differs from the license server clock | Fix the clock (NTP) on one of the servers. |
| Paid licenses are issued only after the order is paid or administratively approved | Set Payment Status to Paid or Administrative Approval to Approved. |
| You do not have permission to perform license operations | Enable License Operations in the user's role. |
| Application or plan stays Pending | Open it and click Sync to License Server. |
| An activation doesn't appear | Wait for the 5-minute sync or click Refresh from Server; check EspoCRM's cron. |
