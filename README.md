# License Manager Platform

Sell and enforce software licenses, managed from EspoCRM.

| Part | Folder | What it is |
| --- | --- | --- |
| License server | `license-server/` | The authority. HTTPS API for apps (activation, refresh, transfer, trials) and for EspoCRM (applications, plans, issuing, operations, change feed). SQLite database, tamper-evident audit chain, hourly backups. Node.js 22.13+, no npm packages. |
| Core | `packages/lmp-core/` | Shared primitives: license keys, Ed25519-signed activation certificates, canonical JSON. |
| Client SDK | `packages/lmp-client/` | What your Node.js or Electron app uses to activate a key, verify offline and transfer to another computer. |
| EspoCRM extension | `espocrm-extension/` | `license-manager-<version>.zip`: the Licensing tabs (applications, plans, orders, licenses, devices, audit), the sync job, the dashlet and the admin page. EspoCRM 9+. |
| Deploy files | `deploy/` | systemd units (server, hourly backup) and the Let's Encrypt renewal hook. |

## Build

```sh
npm run build        # syntax checks (JS, PHP, JSON, shell), all tests, then both zips in dist/
npm test             # tests only
```

`npm` is only a shortcut: `node scripts/build.mjs` does the same and nothing is installed.

The output is `dist/license-platform.zip` (what the administrator guide calls license-platform.zip: server, SDK, deploy files, docs and the extension zip) and `dist/license-manager-<version>.zip` (the EspoCRM extension on its own).

## Install the license server

On a fresh Debian or Ubuntu server whose DNS name already points at it, with ports 80 and 443 open:

```sh
unzip license-platform.zip && cd license-platform
sudo ./deploy/install.sh --domain lic.example.com --crm-ip <EspoCRM server IP> --email you@example.com
```

It installs Node.js 22, creates the `lmp` user, settings, secrets and signing key, gets a Let's Encrypt certificate that renews automatically, starts the services and prints the three EspoCRM `config:set` commands. Running it again with a newer zip updates the code and keeps settings, keys, secrets and data.

## Documentation

- The **License Manager Administrator Guide** covers installation and daily use.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): support playbook, backups, key and secret rotation.
- [docs/ESPOCRM.md](docs/ESPOCRM.md): extension details, permissions, sync, troubleshooting.
- [docs/SECURITY.md](docs/SECURITY.md): what offline licensing can and cannot enforce.
- [docs/DEVELOPERS.md](docs/DEVELOPERS.md): adding licensing to an application with the SDK.
- [docs/API.md](docs/API.md): the license server HTTP API.
