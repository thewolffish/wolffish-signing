<picture>
  <img src="https://cdn.wolffi.sh/branding/og_image.jpg" alt="wolffish" />
</picture>

# wolffish-signing

**Windows code signing for Wolffish releases.**

A Node.js script that automates the code signing workflow for Windows `.exe` installers using a [Certum](https://www.certum.eu/) certificate from [my-ssl.com](https://my-ssl.com/). Downloads the latest release from GitHub, signs it with `signtool`, and uploads the signed binary back to GitHub and Cloudflare R2.

---

## Prerequisites

- **Windows** — `signtool` only runs on Windows
- **[SimplySign](https://www.certum.eu/en/simplysign/)** — Certum's desktop app for cloud-based certificate signing (must be installed and logged in)
- **[Windows SDK](https://developer.microsoft.com/en-us/windows/downloads/windows-sdk/)** — provides `signtool.exe`
- **Node.js** (v18+)

---

## Setup

```bash
git clone https://github.com/thewolffish/wolffish-signing.git
cd wolffish-signing
npm install
```

Create a `.env` file:

```env
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=thewolffish
GITHUB_REPO=wolffish-app
CERT_THUMBPRINT=your_certificate_thumbprint
SIGNTOOL_PATH=C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret_key
R2_BUCKET_NAME=your_bucket_name
```

---

## Usage

```bash
npm run sign
```

The script will:

1. Find the latest GitHub release with an `.exe` asset
2. Download the unsigned `.exe`
3. Sign it with `signtool` using your Certum certificate
4. Prompt you to approve the signing on the SimplySign app
5. Verify the signature
6. Replace the `.exe` on the GitHub release with the signed version
7. Upload the signed `.exe` and `latest.yml` to Cloudflare R2

---

## How It Works

Certum issues cloud-based code signing certificates. Instead of storing the private key locally, the key lives on Certum's HSM and signing requests are approved through the **SimplySign** mobile/desktop app.

When `signtool` is invoked, it sends a signing request to Certum's servers. You then approve the request on SimplySign, and the signed binary is produced locally.

---

## Links

- **Website** — [wolffi.sh](https://wolffi.sh)
- **Documentation** — [docs.wolffi.sh](https://docs.wolffi.sh/)
- **Discord** — [Join the community](https://discord.com/invite/F5Ue36PzQ)
- **X** — [@the_wolffish](https://x.com/the_wolffish)

---

## License

MIT License — Copyright (c) 2026 [Younes Alturkey](mailto:younes@wolffi.sh)
