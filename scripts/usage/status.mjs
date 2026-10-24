const { GH_TOKEN: token, GITHUB_REPOSITORY: repo, USAGE_COMMIT_SHA: sha } = process.env;
const context = "usage/home-server";
const deadline = Date.now() + 300_000;

async function latest() {
  for (let page = 1; Date.now() < deadline; page++) {
    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/statuses?per_page=100&page=${page}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
      });
    } catch {
      throw new Error("GitHub status request failed");
    }
    if (!response.ok) throw new Error(`GitHub status request failed (HTTP ${response.status})`);
    let statuses;
    try {
      statuses = await response.json();
    } catch {
      throw new Error("Invalid GitHub status response");
    }
    if (!Array.isArray(statuses)) throw new Error("Invalid GitHub status response");
    // GitHub returns newest first, including across pages.
    const receipt = statuses.find(status => status?.context === context && status?.creator?.id === Number(process.env.USAGE_STATUS_CREATOR_ID));
    if (receipt) return receipt;
    if (statuses.length < 100) return null;
  }
  return null;
}

async function main() {
  if (!/^[1-9][0-9]*$/.test(process.env.USAGE_STATUS_CREATOR_ID ?? "")) throw new Error("USAGE_STATUS_CREATOR_ID is required");
  if (!token) throw new Error("GH_TOKEN is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo ?? "")) {
    throw new Error("GITHUB_REPOSITORY must be owner/repository");
  }
  if (!/^[a-f0-9]{40}$/i.test(sha ?? "")) throw new Error("USAGE_COMMIT_SHA must be a full commit SHA");
  while (Date.now() < deadline) {
    const receipt = await latest();
    if (Date.now() >= deadline) break;
    if (receipt?.state === "success") {
      console.log(`${context} succeeded for ${sha}`);
      return;
    }
    if (["error", "failure"].includes(receipt?.state)) throw new Error(`${context} failed for this commit`);
    if (receipt && receipt.state !== "pending") throw new Error("Invalid GitHub status state");
    console.log(`Waiting for ${context} on ${sha}`);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(10_000, deadline - Date.now()))));
  }
  throw new Error(`No successful ${context} receipt within five minutes`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
