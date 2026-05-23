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
    console.error(`\nCopy .env.example to .env and fill in the values.`);
    process.exit(1);
  }
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

async function findLatestReleaseWithExe(octokit) {
  console.log("\n🔍 Step 1: Finding latest GitHub release with .exe asset...");

  const { data: releases } = await octokit.repos.listReleases({
    owner: env("GITHUB_OWNER"),
    repo: env("GITHUB_REPO"),
    per_page: 10,
  });

  for (const release of releases) {
    const exeAsset = release.assets.find((a) => a.name.endsWith(".exe"));
    if (exeAsset) {
      console.log(
        `   Found release: ${release.tag_name} (${release.name || release.tag_name})`,
      );
      console.log(`   Asset: ${exeAsset.name} (${formatBytes(exeAsset.size)})`);

      const proceed = await ask(
        `\n   Sign this release? (y/n): `,
      );
      if (proceed !== "y" && proceed !== "yes") {
        console.log("\n⛔ Aborted.");
        process.exit(0);
      }

      return { release, asset: exeAsset };
    }
  }

  console.error("\n❌ No release found with an .exe asset.");
  process.exit(1);
}

async function downloadAsset(octokit, asset) {
  console.log("\n⬇️  Step 2: Downloading .exe...");

  const tmpDir = path.join(import.meta.dirname, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, asset.name);

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
  return { filePath, tmpDir };
}

function signExe(filePath) {
  console.log("\n✍️  Step 3: Signing with signtool...");

  const signtool = env("SIGNTOOL_PATH");
  const thumbprint = env("CERT_THUMBPRINT");

  const cmd = `"${signtool}" sign /sha1 "${thumbprint}" /tr http://time.certum.pl /td sha256 /fd sha256 /v "${filePath}"`;

  console.log(`   Running: signtool sign ...`);

  try {
    const output = execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
    console.log(`   ${output.trim().split("\n").pop()}`);
    console.log("   ✅ Signtool returned successfully");
  } catch (err) {
    console.error(`\n❌ Signing failed:\n${err.stderr || err.message}`);
    process.exit(1);
  }
}

function verifySignature(filePath) {
  console.log("\n🔍 Step 4: Verifying signature...");

  const signtool = env("SIGNTOOL_PATH");
  const cmd = `"${signtool}" verify /pa /all "${filePath}"`;

  try {
    const output = execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
    console.log(`   ${output.trim().split("\n").pop()}`);
    console.log("   ✅ Signature verified");
    return true;
  } catch (err) {
    console.error(`\n❌ Verification failed:\n${err.stderr || err.message}`);
    return false;
  }
}

async function replaceGitHubAsset(octokit, release, oldAsset, filePath) {
  console.log("\n🚀 Step 5: Uploading signed .exe to GitHub release...");

  console.log(`   Deleting unsigned asset (${oldAsset.name})...`);
  await octokit.repos.deleteReleaseAsset({
    owner: env("GITHUB_OWNER"),
    repo: env("GITHUB_REPO"),
    asset_id: oldAsset.id,
  });

  const fileData = fs.readFileSync(filePath);
  console.log(
    `   Uploading signed ${oldAsset.name} (${formatBytes(fileData.length)})...`,
  );

  await octokit.repos.uploadReleaseAsset({
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

  console.log("   ✅ GitHub release updated");
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

  console.log(`   Bucket: ${bucket}`);
  console.log(`   Key: ${exeKey}`);
  console.log(`   Size: ${formatBytes(fileData.length)}`);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: exeKey,
      Body: fileData,
      ContentType: "application/octet-stream",
    }),
  );
  console.log("   ✅ .exe uploaded");

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

  console.log(`   Updating latest.yml (sha512: ${sha512.slice(0, 16)}...)`);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "latest.yml",
      Body: latestYml,
      ContentType: "application/yaml",
    }),
  );

  console.log("   ✅ latest.yml updated");
}

function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

async function main() {
  console.log("===========================================");
  console.log("  Wolffish Sign & Release");
  console.log("===========================================");

  checkEnv();

  const octokit = new Octokit({ auth: env("GITHUB_TOKEN") });

  const { release, asset } = await findLatestReleaseWithExe(octokit);

  const { filePath, tmpDir } = await downloadAsset(octokit, asset);

  try {
    signExe(filePath);

    const approved = await ask(
      "\n⏳ Did you approve the signing on SimplySign app? (y/n): ",
    );

    if (approved !== "y" && approved !== "yes") {
      console.log("\n⛔ Aborted. Re-run when ready to approve.");
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
    console.log("  ✅ Done!");
    console.log("===========================================");
    console.log(`  Release:   ${release.tag_name}`);
    console.log(`  File:      ${asset.name}`);
    console.log(`  Size:      ${formatBytes(fileSize)}`);
    console.log(`  Signed:    Yes`);
    console.log(`  GitHub:    Uploaded`);
    console.log(`  R2:        Uploaded`);
    console.log("===========================================\n");
  } finally {
    cleanup(tmpDir);
  }
}

main().catch((err) => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});
