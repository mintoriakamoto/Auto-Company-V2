// SnapOG — transactional email via Resend (Workers-native, fetch-based).
//
// No-ops safely when RESEND_API_KEY / EMAIL_FROM are unset, so the product
// runs without email configured; wiring a provider only adds delivery.

import type { Env } from './types';

const RESEND_API = 'https://api.resend.com/emails';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export function emailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

// Build the Resend request body — pure, so it is unit-testable.
export function buildResendPayload(from: string, msg: EmailMessage): Record<string, unknown> {
  return { from, to: [msg.to], subject: msg.subject, html: msg.html };
}

// Send an email. Returns true on success, false if not configured or on error
// (never throws — callers use waitUntil and must not fail the request).
export async function sendEmail(env: Env, msg: EmailMessage): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildResendPayload(env.EMAIL_FROM as string, msg)),
    });
    if (!res.ok) {
      console.error(`Resend error ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('sendEmail failed:', err);
    return false;
  }
}

const wrap = (title: string, inner: string): string =>
  `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;">
     <h2 style="color:#0A0A0A;">${title}</h2>${inner}
     <p style="color:#888;font-size:12px;margin-top:32px;">SnapOG — OG images at the edge.</p>
   </div>`;

export function apiKeyEmail(email: string, rawKey: string, appUrl: string): EmailMessage {
  return {
    to: email,
    subject: 'Your SnapOG API key',
    html: wrap(
      'Your SnapOG API key',
      `<p>Here is your API key. Keep it somewhere safe:</p>
       <pre style="background:#f4f4f4;padding:12px;border-radius:6px;font-size:14px;">${rawKey}</pre>
       <p><a href="${appUrl}/dashboard?key=${encodeURIComponent(rawKey)}">Open your dashboard →</a></p>`
    ),
  };
}

export function receiptEmail(email: string, tier: string, appUrl: string): EmailMessage {
  return {
    to: email,
    subject: `You're on SnapOG ${tier}`,
    html: wrap(
      `Welcome to SnapOG ${tier}`,
      `<p>Your upgrade is active — thank you! Your new monthly limit is live now.</p>
       <p><a href="${appUrl}">Back to SnapOG →</a></p>`
    ),
  };
}

export function activationNudgeEmail(email: string, rawKey: string, appUrl: string): EmailMessage {
  return {
    to: email,
    subject: 'Generate your first OG image (2 min)',
    html: wrap(
      'Ready when you are',
      `<p>You created a SnapOG key but haven't generated an image yet. One curl:</p>
       <pre style="background:#f4f4f4;padding:12px;border-radius:6px;font-size:13px;">curl "${appUrl}/og?title=Hello+World&key=${encodeURIComponent(rawKey)}" --output og.png</pre>
       <p><a href="${appUrl}/dashboard?key=${encodeURIComponent(rawKey)}">Open your dashboard →</a></p>`
    ),
  };
}
