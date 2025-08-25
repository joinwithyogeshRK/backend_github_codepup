import fetch from "node-fetch";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
dotenv.config();

const corsHeaders = {
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Allow-Origin": "http://localhost:5173",
};

export default async function (context, req) {
  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    context.res = {
      status: 200,
      headers: corsHeaders,
      body: "",
    };
    return;
  }

  const prisma = new PrismaClient();

  try {
    // Get token from database using Prisma
    const tokenData = await prisma.github.findUnique({
      where: {
        id: 1,
      },
    });

    if (!tokenData) {
      context.res = {
        status: 401,
        headers: corsHeaders,
        body: JSON.stringify({ error: "GitHub token not found in database" }),
      };
      return;
    }

    const token = tokenData.token?.trim();

    if (!token) {
      context.res = {
        status: 401,
        headers: corsHeaders,
        body: JSON.stringify({ error: "GitHub token not configured" }),
      };
      return;
    }

    const ghRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${token}`, // Changed to 'token' format
        "User-Agent": "Azure-Function-App/1.0",
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!ghRes.ok) {
      const errorText = await ghRes.text();
      context.res = {
        status: ghRes.status,
        headers: corsHeaders,
        body: JSON.stringify({
          error: `GitHub API error: ${ghRes.status}`,
          details: errorText,
        }),
      };
      return;
    }

    const data = await ghRes.json();

    if (data.login) {
      context.res = {
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          login: data.login,
          avatar_url: data.avatar_url,
          html_url: data.html_url,
          name: data.name,
          public_repos: data.public_repos,
        }),
      };
    } else {
      context.res = {
        status: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Invalid GitHub response",
          details: "No login field found",
        }),
      };
    }
  } catch (err) {
    context.log.error("Function error:", err);
    context.res = {
      status: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Internal server error",
        details: err.message,
      }),
    };
  } finally {
    // Always disconnect Prisma client
    await prisma.$disconnect();
  }
}
