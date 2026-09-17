export async function sendTelegramMessage(token, chatId, text, timeoutMs = 8000) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const err = new Error("telegram_send_failed");
      err.code = "TELEGRAM_SEND_FAILED";
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}
