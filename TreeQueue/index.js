import fs from "fs";
import path from "path";
import "dotenv/config";


export default async function (context, req) {
  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  function shouldSkipDirectory(dirName) {
    const skipDirs = [
      ".git", // Git internal files - NEVER upload
      "node_modules", // Dependencies - too large and not needed
      ".next", // Next.js build output
      "dist", // Build output (sometimes you want this)
      "build", // Build output (sometimes you want this)
      ".svn", // SVN
      ".hg", // Mercurial
      "__pycache__", // Python
      ".pytest_cache", // Python testing
      ".coverage", // Coverage reports
      ".nyc_output", // Coverage reports
      "coverage", // Coverage reports
      "tmp", // Temporary files
      "temp", // Temporary files
      ".vscode", // VSCode settings (optional - you might want to keep this)
      ".idea", // IntelliJ settings (optional)
    ];

    return skipDirs.includes(dirName);
  }

  function shouldSkipFile(fileName) {
    const skipFiles = [
      ".DS_Store", // macOS system file
      "Thumbs.db", // Windows system file
      "desktop.ini", // Windows system file
      "*.log", // Log files (usually not needed in source)
      "*.tmp", // Temporary files
      "*.temp", // Temporary files
      ".env", // Environment files with secrets (keep .env.example)
      ".env.local", // Local environment files
      ".env.production", // Production environment files
      ".env.development", // Development environment files
    ];

    // Only skip actual system files and sensitive files
    if (skipFiles.includes(fileName)) {
      return true;
    }

    // Skip log files but allow other extensions
    if (fileName.endsWith(".log") && !fileName.includes("changelog")) {
      return true;
    }

    return false;
  }

  function isTextFile(fileName) {
    const textExtensions = [
      // Web Development
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".vue",
      ".svelte",
      ".astro",
      ".html",
      ".htm",
      ".xml",
      ".svg",
      ".css",
      ".scss",
      ".sass",
      ".less",
      ".stylus",
      ".json",
      ".jsonc",
      ".json5",

      // Module formats
      ".mjs",
      ".cjs",
      ".esm",

      // Config files
      ".config.js",
      ".config.ts",
      ".config.mjs",
      ".config.cjs",

      // Documentation and text
      ".md",
      ".mdx",
      ".txt",
      ".rst",

      // Other programming languages
      ".py",
      ".java",
      ".cpp",
      ".c",
      ".h",
      ".cs",
      ".php",
      ".rb",
      ".go",
      ".rs",
      ".swift",
      ".kt",
      ".scala",
      ".dart",
      ".lua",

      // Shell scripts
      ".sh",
      ".bash",
      ".zsh",
      ".fish",
      ".ps1",
      ".cmd",
      ".bat",

      // Data and config formats
      ".yml",
      ".yaml",
      ".toml",
      ".ini",
      ".cfg",
      ".conf",
      ".properties",
      ".csv",
      ".tsv",
      ".sql",

      // Environment and config files (common names)
      ".env.example",
      ".env.template",
      ".env.sample",
      ".gitignore",
      ".gitattributes",
      ".editorconfig",
      ".prettierrc",
      ".eslintrc",
      ".babelrc",
      ".browserslistrc",
      ".npmrc",
      ".nvmrc",

      // Map files (source maps)
      ".map",
    ];

    const ext = path.extname(fileName).toLowerCase();
    const fullName = fileName.toLowerCase();

    // Handle files without extensions (like README, LICENSE, Dockerfile, etc.)
    if (!ext) {
      const textFileNames = [
        "readme",
        "license",
        "changelog",
        "contributing",
        "authors",
        "copying",
        "install",
        "news",
        "todo",
        "makefile",
        "dockerfile",
        "procfile",
        "rakefile",
        "gemfile",
        "guardfile",
        "gruntfile",
        "gulpfile",
      ];
      return textFileNames.some((name) => fullName.includes(name));
    }

    // Check if extension is in our text extensions list
    if (textExtensions.includes(ext)) {
      return true;
    }

    // Handle special config file patterns
    if (
      fullName.includes("config") &&
      (ext === ".js" || ext === ".ts" || ext === ".mjs" || ext === ".cjs")
    ) {
      return true;
    }

    // Handle dot files that are configuration
    if (
      fileName.startsWith(".") &&
      (fullName.includes("rc") ||
        fullName.includes("config") ||
        fullName.includes("ignore") ||
        fullName.includes("lint"))
    ) {
      return true;
    }

    return false;
  }

  function isBinaryFile(filePath) {
    try {
      const buffer = fs.readFileSync(filePath);
      // Simple binary detection: check for null bytes in first 1024 bytes
      const sample = buffer.slice(0, Math.min(1024, buffer.length));

      for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) {
          return true; // Found null byte, likely binary
        }
      }

      return false;
    } catch (error) {
      return true; // If we can't read it, assume binary
    }
  }

  function getRecursiveCalls(dir, root = dir) {
    let results = [];

    try {
      const list = fs.readdirSync(dir);

      for (const file of list) {
        const filePath = path.join(dir, file);

        try {
          const stat = fs.statSync(filePath);

          if (stat.isDirectory()) {
            // Skip problematic directories
            if (shouldSkipDirectory(file)) {
              console.log(`Skipping directory: ${file}`);
              continue;
            }

            // Recurse into subfolder
            results = results.concat(getRecursiveCalls(filePath, root));
          } else {
            // Skip problematic files
            if (shouldSkipFile(file)) {
              console.log(`Skipping file: ${file}`);
              continue;
            }

            // Check if it's a text file
            if (!isTextFile(file)) {
              console.log(`Skipping non-text file: ${file}`);
              continue;
            }

            // Double-check by reading a sample to detect binary files
            if (isBinaryFile(filePath)) {
              console.log(`Skipping binary file: ${file}`);
              continue;
            }

            // Make relative path and normalize for GitHub
            const relativePath = path
              .relative(root, filePath)
              .replace(/\\/g, "/");

            // Skip invalid paths
            if (
              !relativePath ||
              relativePath.includes("..") ||
              relativePath.startsWith("/")
            ) {
              console.warn(`Skipping invalid path: ${relativePath}`);
              continue;
            }

            try {
              const content = fs.readFileSync(filePath, "utf-8");

              // Skip very large files (GitHub has limits)
              if (content.length > 1024 * 1024) {
                // 1MB limit
                console.warn(
                  `Skipping large file: ${relativePath} (${(
                    content.length /
                    1024 /
                    1024
                  ).toFixed(2)}MB)`
                );
                continue;
              }

              results.push({
                path: relativePath,
                content: content,
              });
            } catch (readError) {
              console.warn(`Error reading file ${relativePath}:`, readError);
            }
          }
        } catch (statError) {
          console.warn(`Error accessing ${filePath}:`, statError);
        }
      }
    } catch (dirError) {
      console.error(`Error reading directory ${dir}:`, dirError);
    }

    return results;
  }

  const helloTree = async () => {
    const repo = await octokit.request("POST /user/repos", {
      name: "gurani_yogesh_test_repo_207",
      private: true,
      auto_init: true,
    });

    const ref = await octokit.request(
      "GET /repos/joinwithyogeshRK/gurani_yogesh_test_repo_207/git/ref/heads/main"
    );

    // This gives you the latest commit SHA (parent commit)
    const parentSha = ref.data.object.sha;

    console.log("Parent commit SHA:", parentSha);
    const filesEncoded = getRecursiveCalls("fliokart");

    const tree = filesEncoded.map((f) => ({
      path: f.path,
      content: f.content,
      mode: "100644",
      type: "blob",
    }));

    const responsetreesha = await octokit.request(
      "POST /repos/joinwithyogeshRK/gurani_yogesh_test_repo_207/git/trees",
      {
        tree,
      }
    );

    const responsecommitsha = await octokit.request(
      "POST /repos/joinwithyogeshRK/gurani_yogesh_test_repo_207/git/commits",
      {
        message: "successful initial commit",
        tree: responsetreesha.data.sha,
        parents: [parentSha],
      }
    );

    const response = await octokit.request(
      "PATCH /repos/joinwithyogeshRK/gurani_yogesh_test_repo_207/git/refs/heads/main",
      {
        sha: responsecommitsha.data.sha,
      }
    );

    return response.data;
  };

  try {
    const response = await helloTree();
    context.log("function called successfully");

    return {
      body: "hello",
    };
  } catch (error) {
    context.log("Error:", error);
    return {
      status: 500,
      body: "Error occurred",
    };
  }
}
