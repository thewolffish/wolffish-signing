import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Octokit } from "@octokit/rest";
import "dotenv/config";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const REQUIRED_ENV = [
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "CERT_THUMBPRINT",
  "SIGNTOOL_PATH",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
];

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(
      `\n❌ Missing environment variables:\n  ${missing.join("\n  ")}`,
    );
    console.error(`\nCopy .env.example to .env and fill in the secure values.`);
    process.exit(1);
  }
  console.log("✅ All environment variables loaded");
}

function env(key) {
  return process.env[key];
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

const MAX_VERSIONS = 5;

async function selectReleaseToSign(octokit) {
  console.log("\n🔍 Step 1: Finding recent GitHub releases with .exe assets...");
  console.log(`   Repo: ${env("GITHUB_OWNER")}/${env("GITHUB_REPO")}`);

  let releases;
  try {
    const res = await octokit.repos.listReleases({
      owner: env("GITHUB_OWNER"),
      repo: env("GITHUB_REPO"),
      per_page: 30,
    });
    releases = res.data;
    console.log(`   Found ${releases.length} releases`);
  } catch (err) {
    console.error(`\n❌ Failed to fetch releases: ${err.message}`);
    process.exit(1);
  }

  // Collect up to MAX_VERSIONS most-recent releases that have an .exe asset.
  const candidates = [];
  for (const release of releases) {
    const exeAsset = release.assets.find((a) => a.name.endsWith(".exe"));
    if (exeAsset) {
      candidates.push({ release, asset: exeAsset });
      if (candidates.length === MAX_VERSIONS) break;
    }
  }

  if (candidates.length === 0) {
    console.error("\n❌ No release found with an .exe asset.");
    process.exit(1);
  }

  console.log(`\n   Last ${candidates.length} release(s) with an .exe asset:`);
  candidates.forEach(({ release, asset }, i) => {
    const tag = release.name || release.tag_name;
    const marker = i === 0 ? "  ← latest" : "";
    console.log(
      `     ${i + 1}) ${release.tag_name} (${tag}) — ${asset.name} (${formatBytes(asset.size)})${marker}`,
    );
  });

  let choice;
  while (true) {
    const answer = await ask(
      `\n   Select version to sign [1-${candidates.length}] (Enter = 1, latest): `,
    );
    if (answer === "") {
      choice = 1;
      break;
    }
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= candidates.length) {
      choice = n;
      break;
    }
    console.log(
      `   ⚠️  Please enter a number between 1 and ${candidates.length}.`,
    );
  }

  const selected = candidates[choice - 1];
  console.log(
    `\n   ✅ Selected #${choice}: ${selected.release.tag_name} — ${selected.asset.name}`,
  );
  return selected;
}

async function downloadAsset(octokit, asset) {
  console.log("\n⬇️  Step 2: Downloading .exe...");
  console.log(`   Asset ID: ${asset.id}`);
  console.log(`   File: ${asset.name}`);

  const tmpDir = path.join(import.meta.dirname, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, asset.name);

  try {
    const { data } = await octokit.repos.getReleaseAsset({
      owner: env("GITHUB_OWNER"),
      repo: env("GITHUB_REPO"),
      asset_id: asset.id,
      headers: { Accept: "application/octet-stream" },
    });

    fs.writeFileSync(filePath, Buffer.from(data));
    const size = fs.statSync(filePath).size;
    console.log(`   Saved to: ${filePath}`);
    console.log(`   Size: ${formatBytes(size)}`);
    console.log("   ✅ Download complete");
    return { filePath, tmpDir };
  } catch (err) {
    console.error(`\n❌ Download failed: ${err.message}`);
    process.exit(1);
  }
}

function signExe(filePath) {
  console.log("\n✍️  Step 3: Signing with signtool...");

  const signtool = env("SIGNTOOL_PATH");
  const thumbprint = env("CERT_THUMBPRINT");

  console.log(`   Signtool: ${signtool}`);
  console.log(`   Thumbprint: ${thumbprint.slice(0, 8)}...`);
  console.log(`   Timestamp: http://time.certum.pl`);

  const cmd = `"${signtool}" sign /sha1 "${thumbprint}" /tr http://time.certum.pl /td sha256 /fd sha256 /v "${filePath}"`;

  console.log(`   Running signtool sign...`);

  try {
    const output = execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
    console.log(`   Output: ${output.trim().split("\n").pop()}`);
    console.log("   ✅ Signtool returned successfully");
  } catch (err) {
    console.error(`\n❌ Signing failed: ${err.stderr || err.message}`);
    process.exit(1);
  }
}

function verifySignature(filePath) {
  console.log("\n🔍 Step 4: Verifying signature...");

  const signtool = env("SIGNTOOL_PATH");
  const cmd = `"${signtool}" verify /pa /all "${filePath}"`;

  console.log(`   Running signtool verify...`);

  try {
    const output = execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
    console.log(`   Output: ${output.trim().split("\n").pop()}`);
    console.log("   ✅ Signature verified");
    return true;
  } catch (err) {
    console.error(`\n❌ Verification failed: ${err.stderr || err.message}`);
    return false;
  }
}

async function replaceGitHubAsset(octokit, release, oldAsset, filePath) {
  console.log("\n🚀 Step 5: Uploading signed .exe to GitHub release...");

  console.log(`   Deleting unsigned asset: ${oldAsset.name} (ID: ${oldAsset.id})...`);
  try {
    await octokit.repos.deleteReleaseAsset({
      owner: env("GITHUB_OWNER"),
      repo: env("GITHUB_REPO"),
      asset_id: oldAsset.id,
    });
    console.log("   ✅ Old asset deleted");
  } catch (err) {
    console.error(`\n❌ Failed to delete old asset: ${err.message}`);
    process.exit(1);
  }

  const fileData = fs.readFileSync(filePath);
  console.log(
    `   Uploading signed ${oldAsset.name} (${formatBytes(fileData.length)})...`,
  );

  try {
    const { data: newAsset } = await octokit.repos.uploadReleaseAsset({
      owner: env("GITHUB_OWNER"),
      repo: env("GITHUB_REPO"),
      release_id: release.id,
      name: oldAsset.name,
      data: fileData,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": fileData.length,
      },
    });
    console.log(`   New asset ID: ${newAsset.id}`);
    console.log(`   Download URL: ${newAsset.browser_download_url}`);
    console.log("   ✅ GitHub release updated");
  } catch (err) {
    console.error(`\n❌ Failed to upload signed asset: ${err.message}`);
    process.exit(1);
  }
}

function getR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    },
  });
}

async function uploadToR2(filePath, release) {
  console.log("\n☁️  Step 6: Uploading signed .exe to Cloudflare R2...");

  const s3 = getR2Client();
  const bucket = env("R2_BUCKET_NAME");
  const fileData = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const tag = release.tag_name;
  const exeKey = `${tag}/${fileName}`;

  console.log(`   Endpoint: https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`);
  console.log(`   Bucket: ${bucket}`);
  console.log(`   Key: ${exeKey}`);
  console.log(`   Size: ${formatBytes(fileData.length)}`);

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: exeKey,
        Body: fileData,
        ContentType: "application/octet-stream",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    console.log("   ✅ .exe uploaded to R2");
  } catch (err) {
    console.error(`\n❌ R2 .exe upload failed: ${err.message}`);
    process.exit(1);
  }

  const sha512 = createHash("sha512").update(fileData).digest("base64");
  const version = tag.startsWith("v") ? tag.slice(1) : tag;

  const latestYml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${exeKey}`,
    `    sha512: ${sha512}`,
    `    size: ${fileData.length}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n");

  console.log(`   Updating latest.yml...`);
  console.log(`   SHA-512: ${sha512.slice(0, 24)}...`);
  console.log(`   Version: ${version}`);

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "latest.yml",
        Body: latestYml,
        ContentType: "application/yaml",
      }),
    );
    console.log("   ✅ latest.yml updated on R2");
  } catch (err) {
    console.error(`\n❌ R2 latest.yml upload failed: ${err.message}`);
    process.exit(1);
  }
}

function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\n🧹 Cleaned up temp folder: ${tmpDir}`);
  } catch (err) {
    console.warn(`\n⚠️  Failed to clean up temp folder: ${err.message}`);
  }
}

async function main() {
  console.log("===========================================");
  console.log("  Wolffish Sign & Release");
  console.log("===========================================");

  checkEnv();

  console.log("\n📡 Connecting to GitHub...");
  const octokit = new Octokit({ auth: env("GITHUB_TOKEN") });

  const { release, asset } = await selectReleaseToSign(octokit);

  const { filePath, tmpDir } = await downloadAsset(octokit, asset);

  try {
    signExe(filePath);

    const approved = await ask(
      "\n⏳ Did you approve the signing on SimplySign app? (y/n): ",
    );

    if (approved !== "y" && approved !== "yes") {
      console.log("\n⛔ Aborted by user. Re-run when ready to approve.");
      cleanup(tmpDir);
      process.exit(0);
    }

    const verified = verifySignature(filePath);
    if (!verified) {
      console.error("\n⛔ Signature verification failed. Aborting upload.");
      cleanup(tmpDir);
      process.exit(1);
    }

    await replaceGitHubAsset(octokit, release, asset, filePath);
    await uploadToR2(filePath, release);

    const fileSize = fs.statSync(filePath).size;

    console.log("\n===========================================");
    console.log("  ✅ All done!");
    console.log("===========================================");
    console.log(`  Release:   ${release.tag_name}`);
    console.log(`  File:      ${asset.name}`);
    console.log(`  Size:      ${formatBytes(fileSize)}`);
    console.log(`  Signed:    ✅ Yes`);
    console.log(`  Verified:  ✅ Yes`);
    console.log(`  GitHub:    ✅ Uploaded`);
    console.log(`  R2 .exe:   ✅ Uploaded`);
    console.log(`  R2 yml:    ✅ Updated`);
    console.log("===========================================\n");
  } finally {
    cleanup(tmpDir);
  }
}

main().catch((err) => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});
