// COINFORCE — iyzico ile kartla yatırma başlatma
// Supabase > Edge Functions > "iyzico-checkout" (Verify JWT: AÇIK)
// Gerekli Secrets: IYZICO_API_KEY, IYZICO_SECRET_KEY, IYZICO_BASE_URL
//   (test: https://sandbox-api.iyzipay.com  —  canlı: https://api.iyzipay.com)
// SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY Supabase tarafından otomatik gelir.

const env = (k) => Deno.env.get(k) || "";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

async function hmacHex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// iyzico IYZWSv2 kimlik doğrulaması: HMACSHA256(randomKey + uriPath + body)
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

async function rpc(fn, args, bearer) {
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: bearer === "service" ? env("SUPABASE_SERVICE_ROLE_KEY") : env("SUPABASE_ANON_KEY"),
      authorization: bearer === "service" ? `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}` : bearer,
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error((data && data.message) || "Sunucu hatası");
  return data;
}

// T.C. kimlik numarası algoritma kontrolü
function tcknOk(s) {
  if (!/^[1-9][0-9]{10}$/.test(s)) return false;
  const d = [...s].map(Number);
  const t10 = ((d[0] + d[2] + d[4] + d[6] + d[8]) * 7 - (d[1] + d[3] + d[5] + d[7])) % 10;
  const t11 = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return (t10 + 10) % 10 === d[9] && t11 === d[10];
}

const clean = (s, n) => String(s || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

export async function handler(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Geçersiz istek" }, 405);
  const bearer = req.headers.get("authorization") || "";
  if (!bearer.startsWith("Bearer ")) return json({ error: "Oturum açmalısın" }, 401);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Geçersiz istek" }, 400); }
  const tckn = String(b.identity_number || "").replace(/\D/g, "");
  const city = clean(b.city, 40), address = clean(b.address, 200);
  if (!tcknOk(tckn)) return json({ error: "Geçerli bir T.C. kimlik numarası gir" }, 400);
  if (city.length < 2 || address.length < 10) return json({ error: "Şehir ve adresini eksiksiz yaz" }, 400);
  if (!env("IYZICO_API_KEY") || !env("IYZICO_SECRET_KEY") || !env("IYZICO_BASE_URL"))
    return json({ error: "Kartla ödeme henüz ayarlanmadı" }, 503);

  let p;
  try { p = await rpc("begin_card_payment", { p_try: Number(b.amount_try) }, bearer); }
  catch (e) { return json({ error: e.message }, 400); }

  const parts = clean(p.full_name || p.username, 60).split(" ");
  const surname = parts.length > 1 ? parts.pop() : parts[0];
  const name = parts.join(" ") || surname;
  // iyzico fiyat biçimi (resmi SDK ile aynı): 4125 -> "4125.0", 4125.5 -> "4125.5"
  const price = ((x) => (x.includes(".") ? x : x + ".0"))(String(parseFloat(Number(p.amount_try).toFixed(2))));
  const ip = (req.headers.get("x-real-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0]).trim();
  let res;
  try {
  res = await iyzico("/payment/iyzipos/checkoutform/initialize/auth/ecom", {
    locale: b.locale === "en" ? "en" : "tr",
    conversationId: p.id,
    price,
    paidPrice: price,
    currency: "TRY",
    basketId: p.id,
    paymentGroup: "PRODUCT",
    callbackUrl: `${env("SUPABASE_URL")}/functions/v1/iyzico-callback`,
    enabledInstallments: [1],
    buyer: {
      id: p.username, name, surname, identityNumber: tckn, email: p.email,
      registrationAddress: address, city, country: "Turkey", ...(ip ? { ip } : {}),
    },
    billingAddress: { contactName: `${name} ${surname}`, city, country: "Turkey", address },
    basketItems: [{ id: "USDT", name: "COINFORCE bakiye yükleme", category1: "Dijital hizmet", itemType: "VIRTUAL", price }],
  });
  if (res.status !== "success" || !res.token || !res.paymentPageUrl)
    return json({ error: res.errorMessage || "Ödeme başlatılamadı" }, 502);
  await rpc("set_payment_token", { p_id: p.id, p_token: res.token, p_callback: `${env("SUPABASE_URL")}/functions/v1/iyzico-callback` }, "service");
  } catch (_e) {
    return json({ error: "Ödeme başlatılamadı" }, 502);
  }
  return json({ paymentPageUrl: res.paymentPageUrl, amount_usdt: p.amount_usdt, rate: p.rate });
}

if (typeof Deno !== "undefined" && Deno.serve) Deno.serve(handler);
