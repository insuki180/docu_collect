const nodemailer = require("nodemailer");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT_LENGTH = 180;
const MAX_HTML_LENGTH = 100000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const rateLimitStore = new Map();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

function getRequestOrigin(event) {
  return (
    event.headers?.origin ||
    event.headers?.Origin ||
    event.headers?.referer ||
    event.headers?.Referer ||
    ""
  );
}

function getClientIp(event) {
  const forwarded = event.headers?.["x-forwarded-for"] || event.headers?.["X-Forwarded-For"];
  return (forwarded || "unknown").split(",")[0].trim();
}

function checkRateLimit(key) {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  entry.count += 1;
  return true;
}

function sanitizeHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .trim();
}

exports.handler = async function handler(event) {
  const origin = getRequestOrigin(event);
  const allowedOrigin = process.env.APP_ORIGIN || "";

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Missing Gmail environment variables" })
    };
  }

  if (allowedOrigin && origin && !origin.startsWith(allowedOrigin)) {
    return {
      statusCode: 403,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Forbidden" })
    };
  }

  const ip = getClientIp(event);
  if (!checkRateLimit(ip)) {
    return {
      statusCode: 429,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Too many email requests" })
    };
  }

  try {
    const { to, subject, html } = JSON.parse(event.body || "{}");
    const normalizedTo = String(to || "").trim().toLowerCase();
    const normalizedSubject = String(subject || "").replace(/\s+/g, " ").trim();
    const sanitizedHtml = sanitizeHtml(html);

    if (!normalizedTo || !normalizedSubject || !sanitizedHtml) {
      return {
        statusCode: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Missing required fields" })
      };
    }

    if (!EMAIL_REGEX.test(normalizedTo)) {
      return {
        statusCode: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Invalid recipient email" })
      };
    }

    if (normalizedSubject.length > MAX_SUBJECT_LENGTH) {
      return {
        statusCode: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Subject too long" })
      };
    }

    if (sanitizedHtml.length > MAX_HTML_LENGTH) {
      return {
        statusCode: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Email body too large" })
      };
    }

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      replyTo: process.env.GMAIL_USER,
      to: normalizedTo,
      subject: normalizedSubject,
      html: sanitizedHtml
    });

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ success: true })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Email send failed" })
    };
  }
};
