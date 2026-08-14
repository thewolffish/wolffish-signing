// Resume a signing run that died after the .exe was already signed.
//
// sign.js deletes the unsigned GitHub asset before uploading the signed one, so
// a failed upload leaves the release with NO .exe. The signed file survives in
// tmp/ (process.exit skips the cleanup handler), so there is no need to re-sign
// — and no need for a second SimplySign approval. This script picks up from
// Step 5 using that local file.
//
//   npm run recover                       → prompts for everything
//   npm run recover -- v1.0.253           → tag pre-filled, still confirms
//   npm run recover -- v1.0.253 ./a.exe   → both pre-filled, still confirms
//   npm run recover -- v1.0.253 --yes     → no confirmation (unattended retry)
//
// Idempotent: safe to re-run if a later step fails.

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Octokit } from "@octokit/rest";
import "dotenv/config";
import { uploadReleaseAsset } from "./github-upload.js";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const REQUIRED_ENV = [
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "SIGNTOOL_PATH",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "CF_ZONE_ID",
  "CF_API_TOKEN",
];

const RELEASES_URL = "https://releases.wolffi.sh";

function env(key) {
  return process.env[key];
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`\n❌ Missing environment variables:\n  ${missing.join("\n  ")}`);
    bail(1);
  }
  console.log("✅ All environment variables loaded");
}

// One shared interface for the whole run. Creating a fresh readline per
// question (as sign.js does) works on a TTY but drops buffered input when
// stdin is a pipe, so the second question never gets an answer.
let rl = null;
const bufferedLines = [];
const waitingAsks = [];
let stdinEnded = false;

function warnInputEnded() {
  console.error("\n\n⛔ Input ended before all questions were answered.");
  console.error("   Nothing was changed.\n");
}

function initPrompts() {
  if (rl) return;
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // Buffer lines rather than using rl.question: when stdin is a pipe, all the
  // input arrives at once and a line can be emitted before the next question
  // registers its handler, which silently drops it.
  rl.on("line", (line) => {
    const next = waitingAsks.shift();
    if (next) next.resolve(line.trim());
    else bufferedLines.push(line.trim());
  });
  // Ctrl-C / Ctrl-D / exhausted pipe: reject anything still waiting rather than
  // hanging. Throwing from inside this listener would be an uncaught crash, so
  // the pending ask() is rejected and unwinds through main() instead.
  rl.on("close", () => {
    stdinEnded = true;
    rl = null; // already closed — closePrompts() must not touch it again
    if (!waitingAsks.length) return;
    warnInputEnded();
    process.exitCode = 1;
    waitingAsks.splice(0).forEach(({ reject }) => reject(new Abort()));
  });
}

function ask(question) {
  if (!stdinEnded) initPrompts();
  process.stdout.write(question);

  const buffered = bufferedLines.shift();
  if (buffered !== undefined) {
    process.stdout.write(`${buffered}\n`);
    return Promise.resolve(buffered);
  }
  if (stdinEnded) {
    warnInputEnded();
    bail(1);
  }

  return new Promise((resolve, reject) => waitingAsks.push({ resolve, reject }));
}

// Must run once prompting is done, or the open handle keeps node alive.
// Idempotent.
function closePrompts() {
  if (rl) {
    const current = rl;
    rl = null;
    current.close();
  }
  process.stdin.pause();
}

// Thrown by bail() to unwind to the top. Carries no message — whatever went
// wrong has already been printed at the point of failure.
class Abort extends Error {}

// Stop the run. Deliberately does NOT call process.exit(): on Windows, exiting
// while the stdin handle is mid-teardown trips a libuv assertion
// (UV_HANDLE_CLOSING in src\win\async.c). Setting exitCode and unwinding lets
// node close its handles and exit with the right status on its own.
function bail(code) {
  closePrompts();
  process.exitCode = code;
  throw new Abort();
}

async function askYesNo(question) {
  const answer = (await ask(question)).toLowerCase();
  return answer === "y" || answer === "yes";
}

// Windows "Copy as path" wraps the path in double quotes — strip them so a
// straight paste just works.
function cleanPath(input) {
  return input.replace(/^["']|["']$/g, "").trim();
}

async function promptForPath() {
  while (true) {
    const answer = await ask(`   Path to the signed .exe: `);
    if (!answer) {
      console.log("   ⚠️  Please enter a path.");
      continue;
    }
    const resolved = path.resolve(cleanPath(answer));
    if (!fs.existsSync(resolved)) {
      console.log(`   ⚠️  No such file: ${resolved}`);
      continue;
    }
    if (!resolved.endsWith(".exe")) {
      console.log("   ⚠️  That isn't a .exe.");
      continue;
    }
    return resolved;
  }
}

// tmp/ is where sign.js leaves the signed build when it dies mid-run, so that's
// the default — but accept any path, since tmp/ may already be cleaned up.
async function pickExeFile(argPath) {
  if (argPath) {
    const resolved = path.resolve(cleanPath(argPath));
    if (!fs.existsSync(resolved)) {
      console.error(`\n❌ No such file: ${resolved}`);
      bail(1);
    }
    return resolved;
  }

  const tmpDir = path.join(import.meta.dirname, "tmp");
  const found = fs.existsSync(tmpDir)
    ? fs
        .readdirSync(tmpDir)
        .filter((f) => f.endsWith(".exe"))
        .map((f) => path.join(tmpDir, f))
    : [];

  if (found.length === 0) {
    console.log(`\n📦 Nothing in tmp/ — point me at the signed build.`);
    console.log(`   (If you no longer have it, run 'npm run sign' instead.)\n`);
    return promptForPath();
  }

  if (found.length === 1) {
    const only = found[0];
    console.log(`\n📦 Found a build in tmp/:`);
    console.log(
      `   ${path.basename(only)} (${formatBytes(fs.statSync(only).size)})`,
    );
    const answer = await ask(`\n   Use this? [Y/n, or paste another path]: `);
    const lower = answer.toLowerCase();
    if (answer === "" || lower === "y" || lower === "yes") return only;
    if (lower === "n" || lower === "no") return promptForPath();
    // Anything else is treated as a pasted path.
    const resolved = path.resolve(cleanPath(answer));
    if (fs.existsSync(resolved)) return resolved;
    console.log(`   ⚠️  No such file: ${resolved}`);
    return promptForPath();
  }

  console.log(`\n📦 Found ${found.length} builds in tmp/:`);
  found.forEach((f, i) => {
    console.log(
      `     ${i + 1}) ${path.basename(f)} (${formatBytes(fs.statSync(f).size)})`,
    );
  });
  while (true) {
    const answer = await ask(`\n   Which one? [1-${found.length}]: `);
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= found.length) return found[n - 1];
    console.log(`   ⚠️  Enter a number between 1 and ${found.length}.`);
  }
}

// wolffish-app-1.0.253-setup.exe -> v1.0.253
function deriveTag(filePath) {
  const match = path.basename(filePath).match(/(\d+\.\d+\.\d+)/);
  return match ? `v${match[1]}` : null;
}

async function askTag(argTag, filePath) {
  if (argTag) return argTag;

  const guess = deriveTag(filePath);
  while (true) {
    const answer = await ask(
      guess
        ? `\n   Release tag [Enter = ${guess}]: `
        : `\n   Release tag (e.g. v1.0.253): `,
    );
    if (answer) return answer;
    if (guess) return guess;
    console.log("   ⚠️  Please enter a tag.");
  }
}

// Last stop before anything mutates. Everything above this point is read-only.
async function confirmPlan({ tag, filePath, release, assumeYes }) {
  const fileName = path.basename(filePath);
  const size = fs.statSync(filePath).size;
  const existing = release.assets.find((a) => a.name === fileName);

  const githubPlan = !existing
    ? "will upload (currently missing)"
    : existing.size === size
      ? "already up to date — will skip"
      : `will replace ${formatBytes(existing.size)} asset`;

  console.log("\n-------------------------------------------");
  console.log("  About to publish:");
  console.log(`    Release:  ${tag} (id ${release.id})`);
  console.log(`    File:     ${fileName} (${formatBytes(size)})`);
  console.log(`    GitHub:   ${githubPlan}`);
  console.log(`    R2:       ${tag}/${fileName} + latest.yml`);
  console.log(`    CDN:      purge both, then verify`);
  console.log("-------------------------------------------");
  console.log("  This updates a public release and repoints auto-update.");

  if (assumeYes) {
    console.log("\n  --yes given, proceeding without confirmation.");
    return;
  }

  if (!(await askYesNo("\n  Proceed? (y/n): "))) {
    console.log("\n⛔ Aborted. Nothing was changed.\n");
    bail(0);
  }
}

// Refuse to publish anything that isn't actually signed — the whole point of
// this recovery is that the local copy carries a valid signature.
function verifySignature(filePath) {
  console.log("\n🔍 Step 1: Verifying the local file is signed...");
  const cmd = `"${env("SIGNTOOL_PATH")}" verify /pa /all "${filePath}"`;
  try {
    const output = execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
    console.log(`   Output: ${output.trim().split("\n").pop()}`);
    console.log("   ✅ Signature verified — no need to re-sign");
  } catch (err) {
    console.error(`\n❌ Local file is NOT signed: ${err.stderr || err.message}`);
    console.error("   Re-run 'npm run sign' instead — this file can't be published.");
    bail(1);
  }
}

async function findRelease(octokit, tag) {
  console.log(`\n🔍 Step 2: Locating release ${tag}...`);
  try {
    const { data: release } = await octokit.repos.getReleaseByTag({
      owner: env("GITHUB_OWNER"),
      repo: env("GITHUB_REPO"),
      tag,
    });
    console.log(`   Release ID: ${release.id}`);
    console.log(`   Assets: ${release.assets.length}`);
    return release;
  } catch (err) {
    console.error(`\n❌ Could not find release ${tag}: ${err.message}`);
    bail(1);
  }
}

// Unlike sign.js, upload FIRST and only delete a pre-existing asset if one is
// actually in the way — never leave the release with no installer.
async function uploadGitHubAsset(octokit, release, filePath) {
  console.log("\n🚀 Step 3: Uploading signed .exe to the GitHub release...");

  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  const existing = release.assets.find((a) => a.name === fileName);
  if (existing) {
    if (existing.size === fileSize) {
      console.log(
        `   ✅ Signed asset already present (${formatBytes(existing.size)}) — skipping`,
      );
      return;
    }
    console.log(
      `   Stale asset in the way: ${existing.name} (${formatBytes(existing.size)}), deleting...`,
    );
    await octokit.repos.deleteReleaseAsset({
      owner: env("GITHUB_OWNER"),
      repo: env("GITHUB_REPO"),
      asset_id: existing.id,
    });
    console.log("   ✅ Stale asset deleted");
  }

  console.log(`   Uploading ${fileName} (${formatBytes(fileSize)})...`);

  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const newAsset = await uploadReleaseAsset({
        owner: env("GITHUB_OWNER"),
        repo: env("GITHUB_REPO"),
        releaseId: release.id,
        name: fileName,
        filePath,
        token: env("GITHUB_TOKEN"),
      });
      console.log(`   New asset ID: ${newAsset.id}`);
      console.log(`   Download URL: ${newAsset.browser_download_url}`);
      console.log("   ✅ GitHub release updated");
      return;
    } catch (err) {
      console.log(`   ⚠️  Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt === MAX_ATTEMPTS) {
        console.error(`\n❌ Could not upload the signed asset after ${MAX_ATTEMPTS} tries.`);
        console.error(`   The signed file is safe at: ${filePath}`);
        console.error(
          `   Re-run: npm run recover -- ${release.tag_name} "${filePath}" --yes`,
        );
        bail(1);
      }
      // A failed upload can still leave a partial asset that blocks the retry.
      try {
        const { data: fresh } = await octokit.repos.getRelease({
          owner: env("GITHUB_OWNER"),
          repo: env("GITHUB_REPO"),
          release_id: release.id,
        });
        const partial = fresh.assets.find((a) => a.name === fileName);
        if (partial) {
          await octokit.repos.deleteReleaseAsset({
            owner: env("GITHUB_OWNER"),
            repo: env("GITHUB_REPO"),
            asset_id: partial.id,
          });
          console.log("   Cleared partial asset before retry");
        }
      } catch {
        /* best effort */
      }
      await sleep(Math.min(5000 * attempt, 20000));
    }
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

// Identical output format to sign.js Step 6 — the .exe and latest.yml must move
// together, or the updater will fail sha512 validation against a stale manifest.
async function uploadToR2(filePath, tag) {
  console.log("\n☁️  Step 4: Uploading signed .exe + latest.yml to R2...");

  const s3 = getR2Client();
  const bucket = env("R2_BUCKET_NAME");
  const fileData = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const exeKey = `${tag}/${fileName}`;

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
    bail(1);
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
    bail(1);
  }

  return { sha512, size: fileData.length };
}

async function purgeCloudflareCache(tag, fileName) {
  console.log("\n🧹 Step 5: Purging Cloudflare cache...");

  const zoneId = env("CF_ZONE_ID");
  const exeUrl = `${RELEASES_URL}/${tag}/${fileName}`;
  const ymlUrl = `${RELEASES_URL}/latest.yml`;
  const files = [exeUrl, ymlUrl];

  files.forEach((f) => console.log(`   Purging: ${f}`));

  let res;
  try {
    res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("CF_API_TOKEN")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files }),
      },
    );
  } catch (err) {
    console.error(`\n❌ Cloudflare purge request failed: ${err.message}`);
    bail(1);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    const detail =
      (body.errors || []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    console.error(`\n❌ Cloudflare purge rejected: ${detail}`);
    bail(1);
  }

  console.log("   ✅ Edge cache purged");
}

async function verifyServedArtifact(tag, fileName, expectedSize) {
  console.log("\n🔎 Step 6: Verifying the public URL serves the signed build...");
  const exeUrl = `${RELEASES_URL}/${tag}/${fileName}`;
  const MAX_ATTEMPTS = 8;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(exeUrl, { headers: { Range: "bytes=0-0" } });
      const contentRange = res.headers.get("content-range");
      const total = contentRange
        ? Number(contentRange.split("/")[1] || 0)
        : Number(res.headers.get("content-length") || 0);
      const cache = res.headers.get("cf-cache-status") || "unknown";
      try {
        await res.body?.cancel();
      } catch {
        /* nothing to drain */
      }
      console.log(
        `   Attempt ${attempt}/${MAX_ATTEMPTS}: served size ${total}, signed size ${expectedSize}, cf-cache-status ${cache}`,
      );
      if (total === expectedSize) {
        console.log("   ✅ Public URL now serves the signed artifact");
        return true;
      }
      console.log("   ⏳ Stale copy still cached — waiting for the purge...");
    } catch (err) {
      console.log(`   ⏳ Verify attempt ${attempt} failed: ${err.message}`);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(Math.min(3000 * attempt, 8000));
  }

  console.warn("\n⚠️  Couldn't confirm the signed build at the edge yet.");
  console.warn(`   Re-check: curl -sIL ${exeUrl} | grep -i content-length`);
  return false;
}

async function main() {
  console.log("===========================================");
  console.log("  Wolffish Recover (resume after failed upload)");
  console.log("===========================================");

  const argv = process.argv.slice(2);
  const assumeYes = argv.includes("--yes") || argv.includes("-y");
  const positional = argv.filter((a) => !a.startsWith("-"));

  checkEnv();

  const filePath = await pickExeFile(positional[1]);
  const tag = await askTag(positional[0], filePath);
  const fileName = path.basename(filePath);

  verifySignature(filePath);

  const octokit = new Octokit({ auth: env("GITHUB_TOKEN") });
  const release = await findRelease(octokit, tag);

  await confirmPlan({ tag, filePath, release, assumeYes });
  closePrompts();

  await uploadGitHubAsset(octokit, release, filePath);
  const { size } = await uploadToR2(filePath, tag);
  await purgeCloudflareCache(tag, fileName);
  const servedSigned = await verifyServedArtifact(tag, fileName, size);

  console.log("\n===========================================");
  console.log("  ✅ Recovered!");
  console.log("===========================================");
  console.log(`  Release:   ${tag}`);
  console.log(`  File:      ${fileName}`);
  console.log(`  Size:      ${formatBytes(size)}`);
  console.log(`  Signed:    ✅ Verified`);
  console.log(`  GitHub:    ✅ Uploaded`);
  console.log(`  R2 .exe:   ✅ Uploaded`);
  console.log(`  R2 yml:    ✅ Updated`);
  console.log(
    servedSigned
      ? `  CF purge:  ✅ Purged & verified at edge`
      : `  CF purge:  ✅ Purged (edge still propagating — re-check shortly)`,
  );
  console.log("===========================================\n");

  const tmpDir = path.join(import.meta.dirname, "tmp");
  if (filePath.startsWith(tmpDir)) {
    console.log(`  tmp/ left intact. Delete it once you've confirmed the release.\n`);
  }
}

main().catch((err) => {
  // bail() already printed the reason and set the exit code.
  if (err instanceof Abort) return;
  closePrompts();
  console.error(`\n❌ Fatal error: ${err.message}`);
  process.exitCode = 1;
});
