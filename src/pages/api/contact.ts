import type { APIRoute } from "astro";
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

export const prerender = false;

// Indirizzo email del titolare (riceve le notifiche)
const OWNER_EMAIL = "info@pixxel.media";
const OWNER_NAME = "Pixxel.media";

// Mittente delle email (deve usare il dominio configurato in Email Sending)
const FROM_EMAIL = "forms@pixxel.media";
const FROM_NAME = "Pixxel.media — Form contatti";

// Reply-To: dove arrivano le risposte del cliente alle email automatiche
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

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const env = (locals as any).runtime?.env as {
    DB: D1Database;
    SEND_EMAIL: SendEmail;
  };

  if (!env?.DB || !env?.SEND_EMAIL) {
    return new Response(
      JSON.stringify({ ok: false, error: "Bindings non disponibili" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Parse del body
  let payload: ContactPayload;
  try {
    payload = (await request.json()) as ContactPayload;
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "JSON non valido" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Validazione
  const nome = (payload.nome || "").trim();
  const email = (payload.email || "").trim().toLowerCase();
  const telefono = (payload.telefono || "").trim();
  const messaggio = (payload.messaggio || "").trim();

  if (!nome || nome.length < 2) {
    return new Response(
      JSON.stringify({ ok: false, error: "Nome non valido" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (!email || !isValidEmail(email)) {
    return new Response(
      JSON.stringify({ ok: false, error: "Email non valida" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (!messaggio || messaggio.length < 10) {
    return new Response(
      JSON.stringify({ ok: false, error: "Messaggio troppo breve (minimo 10 caratteri)" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (messaggio.length > 5000) {
    return new Response(
      JSON.stringify({ ok: false, error: "Messaggio troppo lungo" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Salvataggio in D1
  const ip = clientAddress || "unknown";
  const userAgent = request.headers.get("user-agent") || "unknown";

  let contactId: number | null = null;
  try {
    const result = await env.DB.prepare(
      "INSERT INTO contacts (nome, email, telefono, messaggio, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(nome, email, telefono || null, messaggio, ip, userAgent)
      .run();
    contactId = result.meta.last_row_id ?? null;
  } catch (err) {
    console.error("DB insert error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: "Errore database" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // === Email 1: notifica al titolare ===
  try {
    const ownerMsg = createMimeMessage();
    ownerMsg.setSender({ name: FROM_NAME, addr: FROM_EMAIL });
    ownerMsg.setRecipient(OWNER_EMAIL);
    ownerMsg.setHeader("Reply-To", `${nome} <${email}>`);
    ownerMsg.setSubject(`Nuova richiesta da ${nome}${contactId ? ` [#${contactId}]` : ""}`);
    ownerMsg.addMessage({
      contentType: "text/html",
      data: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#222">
          <h2 style="color:#111">Nuova richiesta dal sito</h2>
          <table style="border-collapse:collapse;width:100%;margin-top:16px">
            <tr><td style="padding:8px;border-bottom:1px solid #eee;width:140px"><strong>Nome</strong></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(nome)}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee"><strong>Email</strong></td><td style="padding:8px;border-bottom:1px solid #eee"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
            ${telefono ? `<tr><td style="padding:8px;border-bottom:1px solid #eee"><strong>Telefono</strong></td><td style="padding:8px;border-bottom:1px solid #eee"><a href="tel:${escapeHtml(telefono)}">${escapeHtml(telefono)}</a></td></tr>` : ""}
            <tr><td style="padding:8px;vertical-align:top"><strong>Messaggio</strong></td><td style="padding:8px;white-space:pre-wrap">${escapeHtml(messaggio)}</td></tr>
          </table>
          <p style="font-size:12px;color:#888;margin-top:24px">
            ID richiesta: ${contactId ?? "n/d"}<br>
            IP: ${escapeHtml(ip)}<br>
            Inviata da pixxel.media/contatti
          </p>
        </div>
      `,
    });

    const emailToOwner = new EmailMessage(FROM_EMAIL, OWNER_EMAIL, ownerMsg.asRaw());
    await env.SEND_EMAIL.send(emailToOwner);
  } catch (err) {
    console.error("Errore invio email al titolare:", err);
    // Non blocchiamo: la richiesta è comunque salvata in DB
  }

  // === Email 2: conferma al cliente ===
  try {
    const userMsg = createMimeMessage();
    userMsg.setSender({ name: "Pixxel.media", addr: FROM_EMAIL });
    userMsg.setRecipient(email);
    userMsg.setHeader("Reply-To", REPLY_TO);
    userMsg.setSubject("Abbiamo ricevuto la tua richiesta — Pixxel.media");
    userMsg.addMessage({
      contentType: "text/html",
      data: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#222">
          <h2 style="color:#111">Ciao ${escapeHtml(nome)},</h2>
          <p>abbiamo ricevuto la tua richiesta e ti risponderemo al più presto, di solito entro 24 ore lavorative.</p>
          <p>Se hai urgenza, puoi contattarci direttamente:</p>
          <ul style="line-height:1.8">
            <li>📞 <a href="tel:+390825891796">0825 891796</a></li>
            <li>✉️ <a href="mailto:info@pixxel.media">info@pixxel.media</a></li>
          </ul>
          <p>A presto!</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="font-size:13px;color:#666">
            <strong>Pixxel.media</strong><br>
            Officina di stampa e comunicazione visiva<br>
            Via Nazionale Santa Barbara, 87 — 83031 Ariano Irpino (AV)<br>
            <a href="https://pixxel.media">pixxel.media</a>
          </p>
        </div>
      `,
    });

    const emailToUser = new EmailMessage(FROM_EMAIL, email, userMsg.asRaw());
    await env.SEND_EMAIL.send(emailToUser);
  } catch (err) {
    console.error("Errore invio conferma al cliente:", err);
    // Non blocchiamo
  }

  return new Response(
    JSON.stringify({ ok: true, id: contactId }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};