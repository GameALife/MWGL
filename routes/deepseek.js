const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com/v1").replace(/\/$/, "");

export function hasKey() {
  return Boolean(DEEPSEEK_KEY);
}

export function getBase() {
  return DEEPSEEK_BASE;
}

export async function callDeepSeek(messages, temperature = 0.2) {
  const body = { model: "deepseek-chat", temperature, messages };
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_KEY}`
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(text.slice(0, 600));
    err.status = res.status;
    throw err;
  }
  const data = JSON.parse(text);
  return data?.choices?.[0]?.message?.content || "";
}
