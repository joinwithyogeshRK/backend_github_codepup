import { ServiceBusClient } from "@azure/service-bus";
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const connectionString = process.env.ServiceBusConnection;

// Simple validation for repository name
const validateRepoName = (repoName) => {
  if (typeof repoName !== "string") {
    return { isValid: false, error: "Repository name must be a string" };
  }

  const trimmed = repoName.trim();

  if (!trimmed) {
    return { isValid: false, error: "Repository name is required" };
  }

  if (trimmed.length > 100) {
    return {
      isValid: false,
      error: "Repository name must be 100 characters or less",
    };
  }

  // GitHub repository name rules
  const githubRepoRegex = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

  if (!githubRepoRegex.test(trimmed)) {
    return {
      isValid: false,
      error:
        "Repository name can only contain letters, numbers, hyphens, underscores, and periods. Must start and end with a letter or number.",
    };
  }

  // Check for dangerous patterns (prevent shell injection)
  const dangerousPatterns = [
    /[;&|`$(){}[\]\\]/, // Shell metacharacters
    /\.\./, // Directory traversal
    /^-/, // Starting with dash
    /\s/, // Whitespace
    /['"`]/, // Quote characters
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmed)) {
      return {
        isValid: false,
        error: "Repository name contains invalid characters",
      };
    }
  }

  // Reserved names that could cause issues
  const reservedNames = ["con", "prn", "aux", "nul", ".", "..", "git"];

  if (reservedNames.includes(trimmed.toLowerCase())) {
    return {
      isValid: false,
      error: "Repository name cannot be a reserved system name",
    };
  }

  return { isValid: true, sanitized: trimmed };
};

// Simple validation for ZIP URL
const validateZipUrl = (zipUrl) => {
  if (typeof zipUrl !== "string") {
    return { isValid: false, error: "ZIP URL must be a string" };
  }

  const trimmed = zipUrl.trim();

  if (!trimmed) {
    return { isValid: false, error: "ZIP URL is required" };
  }

  // URL length check
  if (trimmed.length > 2048) {
    return { isValid: false, error: "URL too long" };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch (error) {
    return { isValid: false, error: "Invalid URL format" };
  }

  // Only allow HTTPS for security
  if (parsedUrl.protocol !== "https:") {
    return { isValid: false, error: "Only HTTPS URLs are allowed" };
  }

  // Check if URL ends with .zip
  if (!trimmed.toLowerCase().endsWith(".zip")) {
    return { isValid: false, error: "URL must point to a .zip file" };
  }

  return { isValid: true, sanitized: trimmed };
};

export default async function (context, req) {
  context.log("Function started");

  // Enhanced logging
  context.log("Environment check:", {
    hasConnectionString: !!connectionString,
    connectionStringLength: connectionString?.length || 0,
    nodeEnv: process.env.NODE_ENV,
    functionName: context.functionName,
  });

  // Handle CORS with dynamic origin
  const corsHeaders = {
    "Access-Control-Allow-Origin":
      process.env.FRONTEND_URL || "http://localhost:5173",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: corsHeaders };
    return;
  }

  if (req.method !== "POST") {
    context.res = {
      status: 405,
      headers: corsHeaders,
      body: { error: "Only POST allowed" },
    };
    return;
  }

  if (!connectionString) {
    context.log.error("ServiceBusConnection environment variable is not set");
    context.res = {
      status: 500,
      headers: corsHeaders,
      body: { error: "Service Bus connection string not configured" },
    };
    return;
  }

  // Validate request body exists
  if (!req.body || typeof req.body !== "object") {
    context.res = {
      status: 400,
      headers: corsHeaders,
      body: { error: "Invalid request body" },
    };
    return;
  }

  // Get token from database
  const prisma = new PrismaClient();
  let authToken;

  try {
    context.log("Attempting database connection...");
    const tokenRecord = await prisma.github.findUnique({
      where: { id: 1 },
    });

    context.log("Token record found:", !!tokenRecord);

    if (!tokenRecord) {
      context.res = {
        status: 401,
        headers: corsHeaders,
        body: { error: "Authentication token not found in database" },
      };
      return;
    }

    // Extract the actual token value from the record
    authToken = tokenRecord.token;
    context.log("Auth token extracted:", !!authToken);
  } catch (error) {
    context.log.error("Database error:", error.message);
    context.res = {
      status: 500,
      headers: corsHeaders,
      body: { error: "Failed to retrieve authentication token" },
    };
    return;
  } finally {
    await prisma.$disconnect();
  }

  // Validate token exists
  if (!authToken) {
    context.res = {
      status: 401,
      headers: corsHeaders,
      body: { error: "Authentication token is not available" },
    };
    return;
  }

  // Get request data
  const { username, zipUrl, repoName } = req.body || {};

  context.log("Request data:", {
    hasUsername: !!username,
    hasZipUrl: !!zipUrl,
    hasRepoName: !!repoName,
    bodyKeys: Object.keys(req.body || {}),
  });

  if (!username || !zipUrl || !repoName) {
    context.res = {
      status: 400,
      headers: corsHeaders,
      body: { error: "Missing username, zipUrl, or repoName" },
    };
    return;
  }

  // 🔒 VALIDATION: Validate repository name
  const repoNameValidation = validateRepoName(repoName);
  if (!repoNameValidation.isValid) {
    context.log.warn(
      `Repository name validation failed: ${repoNameValidation.error}`,
      {
        repoName:
          typeof repoName === "string" ? repoName.substring(0, 50) : repoName,
      }
    );
    context.res = {
      status: 400,
      headers: corsHeaders,
      body: { error: `Invalid repository name: ${repoNameValidation.error}` },
    };
    return;
  }

  // 🔒 VALIDATION: Validate ZIP URL
  const zipUrlValidation = validateZipUrl(zipUrl);
  if (!zipUrlValidation.isValid) {
    context.log.warn(`ZIP URL validation failed: ${zipUrlValidation.error}`, {
      zipUrl: typeof zipUrl === "string" ? zipUrl.substring(0, 100) : zipUrl,
    });
    context.res = {
      status: 400,
      headers: corsHeaders,
      body: { error: `Invalid ZIP URL: ${zipUrlValidation.error}` },
    };
    return;
  }

  // Use sanitized values
  const sanitizedRepoName = repoNameValidation.sanitized;
  const sanitizedZipUrl = zipUrlValidation.sanitized;

  context.log("✅ Validation passed, using sanitized values:", {
    username,
    sanitizedRepoName,
    sanitizedZipUrl: sanitizedZipUrl.substring(0, 100) + "...", // Truncate for logging
  });

  let serviceBusClient;

  try {
    context.log("Creating Service Bus client...");

    // Create Service Bus client
    serviceBusClient = new ServiceBusClient(connectionString);
    context.log("Service Bus client created");

    const sender = serviceBusClient.createSender("myqueue");
    context.log("Service Bus sender created for 'myqueue'");

    // Prepare message with sanitized data
    const message = {
      username,
      zipUrl: sanitizedZipUrl,
      repoName: sanitizedRepoName,
      authToken,
      timestamp: new Date().toISOString(),
    };

    context.log("Prepared message:", {
      username: message.username,
      repoName: message.repoName,
      hasAuthToken: !!message.authToken,
      timestamp: message.timestamp,
    });

    // Send to Service Bus queue with detailed logging
    context.log("Attempting to send message to Service Bus queue...");

    // Service Bus message format - no need for base64 encoding
    const serviceBusMessage = {
      body: message,
      messageId: `${sanitizedRepoName}-${username}-${Date.now()}`,
      contentType: "application/json",
      timeToLive: 60 * 60 * 1000, // 1 hour TTL
    };

    context.log("Message size:", {
      bodySize: JSON.stringify(message).length,
    });

    const result = await sender.sendMessages(serviceBusMessage);

    context.log("Service Bus send completed successfully");

    context.log(
      `Task successfully queued: ${sanitizedRepoName} by ${username}`
    );

    context.res = {
      status: 200,
      headers: corsHeaders,
      body: {
        success: true,
        message: "Task queued successfully",
        messageId: serviceBusMessage.messageId,
        repoUrl: `https://github.com/${username}/${sanitizedRepoName}`,
        repoName: sanitizedRepoName,
        username: username,
      },
    };

    // Close the sender
    await sender.close();
  } catch (error) {
    context.log.error("Detailed error information:", {
      message: error.message,
      stack: error.stack,
      code: error.code,
      statusCode: error.statusCode,
      name: error.name,
    });

    context.res = {
      status: 500,
      headers: corsHeaders,
      body: {
        error: "Failed to queue task",
        details: error.message, // Remove in production
      },
    };
  } finally {
    // Always close the Service Bus client
    if (serviceBusClient) {
      try {
        await serviceBusClient.close();
        context.log("Service Bus client closed");
      } catch (closeError) {
        context.log.error(
          "Error closing Service Bus client:",
          closeError.message
        );
      }
    }
  }
}
