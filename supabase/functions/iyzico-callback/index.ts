// COINFORCE — iyzico ödeme sonucu (callbackUrl)
// Supabase > Edge Functions > "iyzico-callback" (Verify JWT: KAPALI — iyzico oturumsuz çağırır)
// Gerekli Secrets: IYZICO_API_KEY, IYZICO_SECRET_KEY, IYZICO_BASE_URL, APP_URL
//   APP_URL örn: https://coinforce.github.io/coinforce/
// Ödeme, token ile iyzico'dan tekrar sorgulanıp doğrulanmadan hesaba geçmez.

const env = (k) => Deno.env.get(k) || "";

async function hmacHex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function iyzico(path, payload) {
  const body = JSON.stringify(payload);
  const rnd = String(Date.now()) + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
  const sig = await hmacHex(env("IYZICO_SECRET_KEY"), rnd + path + body);
  const auth = btoa(`apiKey:${env("IYZICO_API_KEY")}&randomKey:${rnd}&signature:${sig}`);
  const r = await fetch(env("IYZICO_BASE_URL").replace(/\/$/, "") + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `IYZWSv2 ${auth}`, "x-iyzi-rnd": rnd },
    body,
  });
  return await r.json();
}

async function service(fn, args) {
  const k = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: k, authorization: `Bearer ${k}` },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  return text ? JSON.parse(text) : null;
}

const back = (result) =>
  new Response(null, { status: 303, headers: { location: `${env("APP_URL") || "/"}?pay=${result}` } });

export async function handler(req) {
  let token = "";
  try {
    if (req.method === "POST") {
      const f = await req.formData();
      token = String(f.get("token") || "");
    } else {
      token = new URL(req.url).searchParams.get("token") || "";
    }
  } catch { /* boş token aşağıda ele alınır */ }
  if (!/^[A-Za-z0-9-]{10,100}$/.test(token)) return back("fail");

  try {
    const r = await iyzico("/payment/iyzipos/checkoutform/auth/ecom/detail", { locale: "tr", token });
    const paid = r.status === "success" && r.paymentStatus === "SUCCESS" && r.token === token && r.currency === "TRY";
    // Kesin başarısızlık: iyzico sorguyu yanıtladı ve ödeme alınmadı
    if (r.status === "success" && r.paymentStatus === "FAILURE") {
      await service("fail_card_payment", { p_token: token, p_error: r.errorMessage || r.paymentStatus });
      return back("fail");
    }
    // Belirsiz durum (API hatası, inceleme vb.): ödeme beklemede kalır, 5 dakikada bir yeniden sorgulanır
    if (!paid || !(r.fraudStatus === undefined || r.fraudStatus === 1)) return back("wait");
    // Canlı ortam dışındaki (sandbox) ödemeler bakiyeye eklenir ama çekilemez
    const live = env("IYZICO_BASE_URL").replace(/\/$/, "") === "https://api.iyzipay.com";
    const res = await service("complete_card_payment", { p_token: token, p_paid_try: Number(r.paidPrice), p_payment_id: String(r.paymentId || ""), p_live: live });
    return back(res === "paid" ? "ok" : "fail");
  } catch (_e) {
    return back("wait");
  }
}

if (typeof Deno !== "undefined" && Deno.serve) Deno.serve(handler);
