import fetch from "node-fetch";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const corsHeaders = {
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // Dynamic origin based on environment
  "Access-Control-Allow-Origin":
    process.env.FRONTEND_URL || "http://localhost:5173",
};

export default async function (context, req) {
  // Handle OPTIONS preflight request
  if (req.method === "OPTIONS") {
    context.res = {
      status: 200,
      headers: corsHeaders,
      body: "",
    };
    return;
  }

  try {
    const code = req.query.code;

    if (!code) {
      context.res = {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing code parameter" }),
      };
      return;
    }

    // Get GitHub access token
    const tokenRes = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code: code,
        }),
      }
    );

    const tokenData = await tokenRes.json();
    const value = tokenData.access_token;
    const prisma = new PrismaClient();
  

    if (!tokenData.access_token) {
      context.res = {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Failed to get access token",
          details: tokenData,
        }),
      };
      return;
    }

    // Get GitHub user data
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
      },
    });

    const userData = await userRes.json();
    const username = userData.login;
    let token ;
    let user
  try{
       user = await prisma.github.findUnique({
      where:{
        id:1
      }

    })
  }catch(e){
    message:e.message
  }
    if(user){
    token = await prisma.github.update({
      where:{
        username:username
      },
      data:{
        
        token:value
      }
    })
    }
    else{
   token = await prisma.github.create({
    data: {
      username: username,
      token: value,
    },
  })
    }
    
    const id = token.id;

    // Dynamic frontend URL
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

    // Set cookie and redirect
    context.res = {
      status: 302,
      headers: {
        ...corsHeaders,
        // "Set-Cookie": `authToken=${tokenData.access_token}; Path=/; Max-Age=3600; `,
        // Dynamic redirect URL
        Location: `${frontendUrl}/realpage?id=${id}`,
      },
    };
  } catch (error) {
    context.log(`Error: ${error.message}`);
    context.res = {
      status: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Internal Server Error",
        details: error.message,
      }),
    };
  }
}
