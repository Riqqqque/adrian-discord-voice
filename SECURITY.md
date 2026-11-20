# Security policy

Please report vulnerabilities privately. Don't put the details in a public issue. Open an issue in this repository titled "Security contact request" with no details in it, and a private way to send them will be arranged. If the repository's **Security** tab offers **Report a vulnerability**, you can use that instead.

Include the version (`adrian version`, and the PC app's version from its settings if the PC app or the PC link is involved), what you found, and how to reproduce it. Supported versions: the latest release of the bot and of the PC app.

In scope: the bot service and its admin page, the installer, the `adrian` command and the update path, the PC satellite link (`src/satellite/`), and the PC app and its PC actions, whose code is in the [A.D.R.I.A.N repository](https://github.com/Riqqqque/A.D.R.I.A.N) (`crates/desktop`, `crates/pc-control`); report those here too.

How A.D.R.I.A.N. protects keys, the server, the admin page and paired PCs, what data leaves the server, and the known open issues are described in [docs/security.md](docs/security.md).
