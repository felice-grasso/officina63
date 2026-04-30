import type { APIRoute } from "astro";
import { EmailMessage } from "cloudflare:email";
import { env } from "cloudflare:workers";

export const prerender = false;

const OWNER_EMAIL = "info@pixxel.media";
const FROM_EMAIL = "forms@pixxel.media";
const FROM_NAME = "Pixxel.media";
const REPLY_TO = "info@pixxel.media";

interface ContactPayload {
  nome: string;
  email: string;
  telefono?: string;
  messaggio: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function encodeUtf8Subject(s: string): string {
  const utf8Bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of utf8Bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function buildMimeMessage(opts: {
  fromName: string;
  fromEmail: string;
  toEmail: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: "${opts.fromName}" <${opts.fromEmail}>`,
    `To: <${opts.toEmail}>`,
    opts.replyTo ? `Reply-To: ${opts.replyTo}` : "",
    `Subject: ${encodeUtf8Subject(opts.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  const body = [
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    opts.text,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    opts.html,
    ``,
    `--${boundary}--`,
    ``,
  ];

  return [...headers, ...body].join("\r\n");
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const e = env as unknown as {
    DB: D1Database;
    SEND_EMAIL: SendEmail;
  };

  if (!e?.DB || !e?.SEND_EMAIL) {
    return new Response(JSON.stringify({ ok: false, error: "Bindings non disponibili" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  let payload: ContactPayload;
  try {
    payload = (await request.json()) as ContactPayload;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "JSON non valido" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const nome = (payload.nome || "").trim();
  const email = (payload.email || "").trim().toLowerCase();
  const telefono = (payload.telefono || "").trim();
  const messaggio = (payload.messaggio || "").trim();

  if (!nome || nome.length < 2) {
    return new Response(JSON.stringify({ ok: false, error: "Nome non valido" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!email || !isValidEmail(email)) {
    return new Response(JSON.stringify({ ok: false, error: "Email non valida" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!messaggio || messaggio.length < 10) {
    return new Response(JSON.stringify({ ok: false, error: "Messaggio troppo breve" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (messaggio.length > 5000) {
    return new Response(JSON.stringify({ ok: false, error: "Messaggio troppo lungo" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const ip = clientAddress || "unknown";
  const userAgent = request.headers.get("user-agent") || "unknown";

  let contactId: number | null = null;
  try {
    const result = await e.DB.prepare(
      "INSERT INTO contacts (nome, email, telefono, messaggio, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(nome, email, telefono || null, messaggio, ip, userAgent).run();
    contactId = result.meta.last_row_id ?? null;
  } catch (err) {
    console.error("DB insert error:", err);
    return new Response(JSON.stringify({ ok: false, error: "Errore database" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // === Email 1: notifica al titolare ===
  try {
    const ownerHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#222"><h2>Nuova richiesta dal sito</h2><table style="border-collapse:collapse;width:100%;margin-top:16px"><tr><td style="padding:8px;border-bottom:1px solid #eee;width:140px"><strong>Nome</strong></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(nome)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee"><strong>Email</strong></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(email)}</td></tr>${telefono ? `<tr><td style="padding:8px;border-bottom:1px solid #eee"><strong>Telefono</strong></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(telefono)}</td></tr>` : ""}<tr><td style="padding:8px;vertical-align:top"><strong>Messaggio</strong></td><td style="padding:8px;white-space:pre-wrap">${escapeHtml(messaggio)}</td></tr></table><p style="font-size:12px;color:#888;margin-top:24px">ID: ${contactId ?? "n/d"} - IP: ${escapeHtml(ip)}</p></div>`;

    const ownerText = `Nuova richiesta dal sito\n\nNome: ${nome}\nEmail: ${email}\n${telefono ? `Telefono: ${telefono}\n` : ""}\nMessaggio:\n${messaggio}\n\nID: ${contactId ?? "n/d"}`;

    const rawOwner = buildMimeMessage({
      fromName: `${FROM_NAME} - Form contatti`,
      fromEmail: FROM_EMAIL,
      toEmail: OWNER_EMAIL,
      replyTo: `${nome} <${email}>`,
      subject: `Nuova richiesta da ${nome}${contactId ? ` [#${contactId}]` : ""}`,
      text: ownerText,
      html: ownerHtml,
    });

    await e.SEND_EMAIL.send(new EmailMessage(FROM_EMAIL, OWNER_EMAIL, rawOwner));
  } catch (err) {
    console.error("Errore invio email titolare:", err);
  }

  // === Email 2: conferma al cliente ===
  try {
    const userHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#222"><h2>Ciao ${escapeHtml(nome)},</h2><p>abbiamo ricevuto la tua richiesta e ti risponderemo al piu presto, di solito entro 24 ore lavorative.</p><p>Se hai urgenza, puoi contattarci direttamente:</p><ul style="line-height:1.8"><li>Telefono: 0825 891796</li><li>Email: info@pixxel.media</li></ul><p>A presto!</p><hr style="border:none;border-top:1px solid #eee;margin:24px 0"><p style="font-size:13px;color:#666"><strong>Pixxel.media</strong><br>Officina di stampa e comunicazione visiva<br>Via Nazionale Santa Barbara, 87 - 83031 Ariano Irpino (AV)</p></div>`;

    const userText = `Ciao ${nome},\n\nabbiamo ricevuto la tua richiesta e ti risponderemo al piu presto, di solito entro 24 ore lavorative.\n\nSe hai urgenza:\nTel: 0825 891796\nEmail: info@pixxel.media\n\nA presto!\nPixxel.media`;

    const rawUser = buildMimeMessage({
      fromName: FROM_NAME,
      fromEmail: FROM_EMAIL,
      toEmail: email,
      replyTo: REPLY_TO,
      subject: "Abbiamo ricevuto la tua richiesta - Pixxel.media",
      text: userText,
      html: userHtml,
    });

    await e.SEND_EMAIL.send(new EmailMessage(FROM_EMAIL, email, rawUser));
  } catch (err) {
    console.error("Errore invio conferma cliente:", err);
  }

  return new Response(JSON.stringify({ ok: true, id: contactId }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
};