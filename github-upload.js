// Release-asset uploads bypass Octokit and go straight through node:https.
//
// Octokit v21 calls globalThis.fetch, which in Node is undici, whose
// headersTimeout defaults to 300s. GitHub withholds response headers until it
// has received and processed the whole body, so that 5-minute clock covers the
// entire upload — a 163 MB installer on a ~4 Mbps uplink takes longer than that
// and dies client-side ("Headers Timeout Error") no matter how healthy the
// transfer is. Raising the limit needs an undici Agent, i.e. a new dependency
// in a code-signing tool; node:https has no equivalent cap.
//
// Streaming the file also keeps 163 MB out of memory.

import fs from "node:fs";
import https from "node:https";

const UPLOAD_HOST = "https://uploads.github.com";

export function uploadReleaseAsset({
  owner,
  repo,
  releaseId,
  name,
  filePath,
  token,
}) {
  const size = fs.statSync(filePath).size;
  const url =
    `${UPLOAD_HOST}/repos/${owner}/${repo}/releases/${releaseId}/assets` +
    `?name=${encodeURIComponent(name)}`;

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);

    // GitHub answers errors (404, 422, auth) before the body finishes sending.
    // Without tearing the stream down, it keeps piping into a request that is
    // already done and the socket holds the event loop open — the process hangs
    // instead of moving on to the next retry.
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      req.destroy();
      fn(value);
    };

    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          authorization: `token ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/octet-stream",
          "content-length": size,
          "user-agent": "wolffish-signing",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode === 201) {
            let asset;
            try {
              asset = JSON.parse(body);
            } catch {
              settle(reject, new Error("GitHub returned 201 with bad JSON"));
              return;
            }
            settle(resolve, asset);
            return;
          }
          // Surface GitHub's own message — it explains duplicate names,
          // permission problems and size limits far better than the status.
          let detail = body.slice(0, 300);
          try {
            detail = JSON.parse(body).message || detail;
          } catch {
            /* keep the raw snippet */
          }
          settle(reject, new Error(`HTTP ${res.statusCode}: ${detail}`));
        });
      },
    );

    req.on("error", (err) => settle(reject, err));
    stream.on("error", (err) => settle(reject, err));
    stream.pipe(req);
  });
}
