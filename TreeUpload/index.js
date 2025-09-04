import path from "path";
import fs from "fs";
import os from "os";
import fetch from "node-fetch";
import AdmZip from "adm-zip";
import "dotenv/config";

// Use Azure Functions temp directory
const TEMP_DIR = path.join(os.tmpdir(), "gh-upload-temp");

// Simple repository name validation
function validateRepositoryName(repoName) {
  if (!repoName || typeof repoName !== "string") {
    throw new Error("Repository name is required");
  }

  const trimmed = repoName.trim();

  // Length check
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new Error("Repository name must be 1-100 characters");
  }

  // Only allow safe characters: letters, numbers, hyphens, underscores, dots
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      "Repository name can only contain letters, numbers, dots, hyphens, and underscores"
    );
  }

  // Cannot start/end with dots or hyphens
  if (/^[.-]|[.-]$/.test(trimmed)) {
    throw new Error("Repository name cannot start or end with dots or hyphens");
  }

  // Block dangerous patterns
  if (/[<>"'`]|javascript:|data:|\.\./.test(trimmed)) {
    throw new Error("Repository name contains invalid characters");
  }

  // Block reserved names
  const reserved = ["api", "www", "admin", "root", "git", "github", "help"];
  if (reserved.includes(trimmed.toLowerCase())) {
    throw new Error("Repository name is reserved");
  }

  return trimmed;
}

// Test GitHub token validity with rate limit handling
const testGitHubToken = async (token, context) => {
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        message: response.statusText,
      }));

      if (
        response.status === 403 &&
        error.message &&
        error.message.includes("rate limit")
      ) {
        context.log.warn(
          "⚠️ GitHub API rate limit hit during token validation. Skipping validation and proceeding..."
        );
        return { login: "rate-limited-user", rateLimit: true };
      }

      throw new Error(
        `GitHub token validation failed: ${
          error.message || response.statusText
        }`
      );
    }

    const userData = await response.json();
    context.log(
      `✅ GitHub token validated successfully for user: ${userData.login}`
    );
    return userData;
  } catch (error) {
    if (error.message.includes("rate limit")) {
      context.log.warn(
        "⚠️ Rate limit hit during token validation, proceeding without validation"
      );
      return { login: "rate-limited-user", rateLimit: true };
    }

    context.log.error("❌ GitHub token validation failed:", error.message);
    throw error;
  }
};

const createRepoIfNotExists = async (token, repoName, username, context) => {
  try {
    // Check if repo already exists
    context.log(`🔍 Checking if repository ${username}/${repoName} exists...`);
    const checkResponse = await fetch(
      `https://api.github.com/repos/${username}/${repoName}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (checkResponse.ok) {
      const existingRepo = await checkResponse.json();
      context.log("✅ Repository already exists:", existingRepo.html_url);
      return existingRepo;
    }

    if (checkResponse.status !== 404) {
      const errorData = await checkResponse.json().catch(() => ({
        message: checkResponse.statusText,
      }));

      if (
        checkResponse.status === 403 &&
        errorData.message &&
        errorData.message.includes("rate limit")
      ) {
        context.log.warn(
          "⚠️ Rate limit hit while checking repository existence. Proceeding with creation attempt..."
        );
      } else {
        throw new Error(
          `Failed to check repository: ${
            errorData.message || checkResponse.statusText
          }`
        );
      }
    }

    // Repository doesn't exist, create it
    context.log(`🚀 Creating new repository: ${repoName}`);
    const response = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        name: repoName,
        private: false,
        description: `Repository created via automated upload`,
        auto_init: false,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(
          "GitHub authentication failed. Please check your token."
        );
      } else if (response.status === 403) {
        if (data.message && data.message.includes("rate limit")) {
          throw new Error(
            `🚫 GitHub API rate limit exceeded. Please wait before trying again. ${data.message}`
          );
        }
        throw new Error(
          "GitHub API access forbidden. Check token permissions (needs 'repo' scope)."
        );
      } else if (response.status === 422) {
        if (data?.errors && Array.isArray(data.errors)) {
          const hasNameExistsError = data.errors.some(
            (err) => err.message && err.message.includes("name already exists")
          );

          if (hasNameExistsError) {
            const verifyResponse = await fetch(
              `https://api.github.com/repos/${username}/${repoName}`,
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: "application/vnd.github+json",
                },
              }
            );

            if (verifyResponse.ok) {
              const existingRepo = await verifyResponse.json();
              context.log(
                "✅ Repository exists and is accessible:",
                existingRepo.html_url
              );
              return existingRepo;
            } else {
              throw new Error(
                `Repository '${repoName}' exists but is not accessible. You might not have permission to access it.`
              );
            }
          }
        }
        throw new Error(
          `Repository creation validation failed: ${
            data.message || "Unknown validation error"
          }`
        );
      } else {
        throw new Error(
          `Repository creation failed: ${data.message || response.statusText}`
        );
      }
    }

    context.log("✅ Repository created successfully:", data.html_url);
    return data;
  } catch (error) {
    context.log.error("❌ Error in createRepoIfNotExists:", error.message);
    throw error;
  }
};

async function downloadAndExtractZip(zipUrl, context) {
  const zipPath = path.join(TEMP_DIR, `download-${Date.now()}.zip`);
  const extractPath = path.join(TEMP_DIR, `unzipped-${Date.now()}`);

  try {
    if (!fs.existsSync(TEMP_DIR)) {
      context.log(`📁 Creating temp directory at: ${TEMP_DIR}`);
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    context.log("⬇️ Downloading zip from:", zipUrl);
    const res = await fetch(zipUrl);
    if (!res.ok) {
      throw new Error(
        `Failed to download zip: ${res.status} ${res.statusText}`
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(zipPath, buffer);

    context.log("📦 Extracting zip to:", extractPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    fs.unlinkSync(zipPath);
    return extractPath;
  } catch (error) {
    context.log.error("❌ Download/Extract error:", error.message);
    try {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      if (fs.existsSync(extractPath))
        fs.rmSync(extractPath, { recursive: true });
    } catch (cleanupError) {
      context.log.error("Cleanup error during failure:", cleanupError.message);
    }
    throw error;
  }
}

function removeWorkflowFiles(dir, context) {
  const githubDir = path.join(dir, ".github");
  if (fs.existsSync(githubDir)) {
    context.log(
      "🗑️ Found .github directory, removing to avoid workflow scope issues..."
    );
    fs.rmSync(githubDir, { recursive: true, force: true });
    context.log("✅ Removed .github directory");
    return true;
  }
  return false;
}

// OPTIMIZED: Fast parallel upload with smart batching
async function uploadToGitHubAPI(
  workingDir,
  token,
  username,
  repoName,
  context
) {
  const baseUrl = `https://api.github.com/repos/${username}/${repoName}/contents`;

  // Collect all files first
  const allFiles = [];

  function collectFiles(dir, basePath = "") {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);
      const relativePath = basePath ? `${basePath}/${item}` : item;
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        collectFiles(itemPath, relativePath);
      } else if (stat.isFile()) {
        allFiles.push({ filePath: itemPath, relativePath });
      }
    }
  }

  collectFiles(workingDir);
  context.log(`📊 Found ${allFiles.length} files to upload`);

  // OPTIMIZED: Upload files in parallel batches
  async function uploadFileBatch(fileBatch) {
    const uploadPromises = fileBatch.map(async ({ filePath, relativePath }) => {
      try {
        const content = fs.readFileSync(filePath);
        const base64Content = content.toString("base64");

        const requestBody = {
          message: `Upload ${relativePath}`,
          content: base64Content,
          committer: {
            name: username,
            email: `${username}@users.noreply.github.com`,
          },
          author: {
            name: username,
            email: `${username}@users.noreply.github.com`,
          },
        };

        const uploadUrl = `${baseUrl}/${relativePath}`;
        const response = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/vnd.github+json",
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({
            message: response.statusText,
          }));

          // If file exists, get SHA and retry
          if (
            response.status === 422 &&
            error.message &&
            error.message.includes("sha")
          ) {
            const existingFileResponse = await fetch(uploadUrl, {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
              },
            });

            if (existingFileResponse.ok) {
              const existingFile = await existingFileResponse.json();
              requestBody.sha = existingFile.sha;

              const retryResponse = await fetch(uploadUrl, {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                  Accept: "application/vnd.github+json",
                },
                body: JSON.stringify(requestBody),
              });

              if (!retryResponse.ok) {
                const retryError = await retryResponse.json().catch(() => ({
                  message: retryResponse.statusText,
                }));
                throw new Error(
                  `Failed to update ${relativePath}: ${retryError.message}`
                );
              }

              context.log(`✅ Updated: ${relativePath}`);
              return retryResponse.json();
            }
          }

          if (
            response.status === 403 &&
            error.message &&
            error.message.includes("rate limit")
          ) {
            throw new Error(`Rate limit hit for ${relativePath}`);
          }

          throw new Error(`Failed to upload ${relativePath}: ${error.message}`);
        }

        context.log(`✅ Created: ${relativePath}`);
        return response.json();
      } catch (error) {
        context.log.error(`❌ Error uploading ${relativePath}:`, error.message);
        throw error;
      }
    });

    return Promise.all(uploadPromises);
  }

  // Process files in batches of 10 (optimized batch size)
  const BATCH_SIZE = 10;
  const totalBatches = Math.ceil(allFiles.length / BATCH_SIZE);

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
    const batch = allFiles.slice(i, i + BATCH_SIZE);

    context.log(
      `⚡ Processing batch ${currentBatch}/${totalBatches} (${batch.length} files)`
    );

    try {
      await uploadFileBatch(batch);
      context.log(`✅ Batch ${currentBatch} completed successfully`);

      // Only add delay between batches (not between individual files)
      // And only if there are more batches to process
      if (i + BATCH_SIZE < allFiles.length) {
        context.log("⏰ Brief pause between batches...");
        await new Promise((resolve) => setTimeout(resolve, 200)); // Reduced to 200ms
      }
    } catch (error) {
      // If batch fails due to rate limit, wait longer and retry
      if (error.message.includes("rate limit")) {
        context.log.warn(
          `⚠️ Rate limit hit in batch ${currentBatch}, waiting 2 seconds...`
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Retry the failed batch
        context.log(`🔄 Retrying batch ${currentBatch}...`);
        await uploadFileBatch(batch);
      } else {
        throw error;
      }
    }
  }

  context.log(`🎉 All ${allFiles.length} files uploaded successfully!`);
}

async function upload(zipUrl, repoName, token, username, context) {
  let extractPath;

  try {
    // Clean up old temp files
    try {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      if (fs.existsSync(TEMP_DIR)) {
        const files = fs.readdirSync(TEMP_DIR);
        files.forEach((file) => {
          const filePath = path.join(TEMP_DIR, file);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > oneHour) {
            fs.rmSync(filePath, { recursive: true, force: true });
          }
        });
      }
    } catch (cleanupError) {
      context.log.warn("⚠️ Temp cleanup warning:", cleanupError.message);
    }

    extractPath = await downloadAndExtractZip(zipUrl, context);

    // Find the actual content directory
    const items = fs.readdirSync(extractPath);
    let workingDir = extractPath;

    context.log("📂 Items in extract path:", items);

    if (
      items.length === 1 &&
      fs.statSync(path.join(extractPath, items[0])).isDirectory()
    ) {
      workingDir = path.join(extractPath, items[0]);
      context.log("📁 Using nested directory:", workingDir);
    }

    // Remove workflow files to avoid scope issues
    const removedWorkflows = removeWorkflowFiles(workingDir, context);
    if (removedWorkflows) {
      context.log("✅ Workflow files removed to prevent permission issues");
    }

    // Verify there are files to upload
    const allFiles = fs.readdirSync(workingDir, { withFileTypes: true });
    const fileCount = allFiles.filter((item) => item.isFile()).length;
    const folderCount = allFiles.filter((item) => item.isDirectory()).length;

    context.log(
      `📊 Found ${fileCount} files and ${folderCount} folders in working directory`
    );

    if (fileCount === 0 && folderCount === 0) {
      throw new Error("No files found to upload");
    }

    context.log("🏗️ Creating repository if it doesn't exist...");
    await createRepoIfNotExists(token, repoName, username, context);

    context.log("🚀 Uploading files via optimized GitHub API...");
    await uploadToGitHubAPI(workingDir, token, username, repoName, context);

    context.log("🎉 Upload completed successfully!");
    return `https://github.com/${username}/${repoName}`;
  } catch (err) {
    context.log.error("❌ Upload failed:", err.message);

    if (err.message.includes("workflow") && err.message.includes("scope")) {
      context.log.error(
        "ERROR: GitHub token needs 'workflow' scope to upload GitHub Actions files"
      );
    }

    if (err.message.includes("Repository not found")) {
      context.log.error(
        "Repository might not exist or token doesn't have access"
      );
    }
    if (
      err.message.includes("authentication failed") ||
      err.message.includes("Bad credentials")
    ) {
      context.log.error(
        "GitHub authentication failed - check token permissions"
      );
    }

    throw err;
  } finally {
    // Clean up temporary files
    if (extractPath && fs.existsSync(extractPath)) {
      try {
        fs.rmSync(extractPath, { recursive: true, force: true });
        context.log("🧹 Cleaned up temporary files");
      } catch (cleanupError) {
        context.log.error("Cleanup error:", cleanupError.message);
      }
    }
  }
}

export default async function (context, mySbMsg) {
  context.log("🚌 Service Bus queue processor started");

  try {
    let content;

    if (typeof mySbMsg === "string") {
      try {
        content = JSON.parse(mySbMsg);
      } catch (parseError) {
        context.log.error(
          "❌ Failed to parse Service Bus message:",
          parseError.message
        );
        throw new Error("Invalid Service Bus message format");
      }
    } else if (mySbMsg && typeof mySbMsg === "object") {
      content = mySbMsg;
    } else {
      throw new Error("Invalid Service Bus message format");
    }

    context.log("📋 Parsed Service Bus content:", {
      username: content.username,
      repoName: content.repoName,
      hasToken: !!content.authToken,
      zipUrl: content.zipUrl ? "present" : "missing",
      messageId: context.bindingData?.messageId || "unknown",
    });

    const { username, zipUrl, repoName, authToken } = content;

    if (!username || !zipUrl || !repoName || !authToken) {
      const missing = [];
      if (!username) missing.push("username");
      if (!zipUrl) missing.push("zipUrl");
      if (!repoName) missing.push("repoName");
      if (!authToken) missing.push("authToken");

      throw new Error(`Missing required fields: ${missing.join(", ")}`);
    }

    const validatedRepoName = validateRepositoryName(repoName);

    if (!authToken.startsWith("ghp_") && !authToken.startsWith("github_pat_")) {
      context.log.warn(
        "⚠️ Token doesn't match expected GitHub format. This might cause authentication issues."
      );
    }

    context.log(`🚀 Processing: ${validatedRepoName} by ${username}`);

    context.log("🔐 Validating GitHub token...");
    const githubUser = await testGitHubToken(authToken, context);

    if (!githubUser.rateLimit && githubUser.login !== "rate-limited-user") {
      if (githubUser.login.toLowerCase() !== username.toLowerCase()) {
        throw new Error(
          `Token belongs to user '${githubUser.login}' but expected '${username}'. Please check your configuration.`
        );
      }
    } else {
      context.log.warn(
        "⚠️ Skipping username verification due to rate limiting"
      );
    }

    const repoUrl = await upload(
      zipUrl,
      validatedRepoName,
      authToken,
      username,
      context
    );

    context.log(`✅ Upload completed: ${repoUrl}`);

    return {
      success: true,
      repoUrl: repoUrl,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    context.log.error("❌ Upload failed:", error.message);
    context.log.error("Error stack:", error.stack);
    throw error;
  }
}
