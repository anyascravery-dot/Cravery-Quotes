// Minimal SANDBOX integration for Square
// File: /api/square-quote.js
// Purpose: Receive quote data, recompute totals (authoritative),
//          create/get Square customer, create Order, create & publish Invoice (emails sandbox invoice)

const SQUARE_BASE = "https://connect.squareupsandbox.com"; // SANDBOX base URL
const SQUARE_VERSION = "2025-09-24"; // or latest shown in your Square dashboard

function money(amount) {
  return { amount: Math.round(amount * 100), currency: "USD" };
}

function reqHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    "Square-Version": SQUARE_VERSION,
    ...extra,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const {
      name,
      email,
      event_address,
      miles,
      package_rate,
      guests
    } = req.body || {};

    if (!name || !email) return res.status(400).json({ error: "Missing name or email" });

    // ---- Recompute totals server-side (authoritative) ----
    const TAX_RATE = 0.0625, TIP_RATE = 0.18, TRAVEL_BASE = 50, PER_MILE = 4;
    const per = parseFloat(package_rate || 0) || 0;
    const guestCount = parseInt(guests || 0, 10) || 0;
    const milesNum = Math.max(0, parseFloat(miles || 0) || 0);

    const items = per * guestCount;         // package * guests
    const tax = TAX_RATE * items;           // tax only on items
    const travel = TRAVEL_BASE + PER_MILE * milesNum;
    const tip = TIP_RATE * items;           // tip only on items
    const totalBeforeTip = travel + (items + tax);
    const finalTotal = totalBeforeTip + tip;

    // ---- Square: create or find customer ----
    const customer = await createOrGetCustomer(email, name);

    // ---- Square: create order ----
    const order = await createOrder({
      locationId: process.env.SQUARE_LOCATION_ID,
      customerId: customer.id,
      per,
      guests: guestCount,
      taxRate: TAX_RATE,
      travel,
      tip,
      note: `Event at ${event_address || "(address not provided)"}. ${milesNum.toFixed(1)} miles.`
    });

    // ---- Square: create + publish invoice (emails customer in Sandbox) ----
    const invoice = await createInvoice({ orderId: order.id, customerId: customer.id });
    const published = await publishInvoice(invoice.id, invoice.version);

    // OPTIONAL: notify owner via Formspree if configured
    if (process.env.FORMSPREE_OWNER_ENDPOINT && process.env.OWNER_EMAIL) {
      try {
        await sendOwnerNotification({
          endpoint: process.env.FORMSPREE_OWNER_ENDPOINT,
          ownerEmail: process.env.OWNER_EMAIL,
          name,
          email,
          event_address,
          miles: milesNum,
          per,
          guests: guestCount,
          totals: { items, tax, travel, tip, totalBeforeTip, finalTotal },
          invoiceUrl: published.public_url || null,
          invoiceId: published.id
        });
      } catch (e) { console.warn("Owner notify failed", e); }
    }

    return res.status(200).json({
      success: true,
      message: "Sandbox invoice created & published",
      invoice_id: published.id,
      invoice_url: published.public_url || null,
      totals: { items, tax, travel, tip, totalBeforeTip, finalTotal }
    });
  } catch (err) {
    console.error("Square error", err);
    // Try to surface Square API errors clearly
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}

async function createOrGetCustomer(email, name) {
  // Search by exact email
  const search = await fetch(`${SQUARE_BASE}/v2/customers/search`, {
    method: "POST",
    headers: reqHeaders(),
    body: JSON.stringify({ query: { filter: { email_address: { exact: email } } } })
  }).then(r => r.json());

  const existing = search?.customers?.[0];
  if (existing) return existing;

  const [given_name, ...rest] = String(name).trim().split(" ");
  const family_name = rest.join(" ") || undefined;

  const created = await fetch(`${SQUARE_BASE}/v2/customers`, {
    method: "POST",
    headers: reqHeaders(),
    body: JSON.stringify({ given_name, family_name, email_address: email })
  }).then(r => r.json());

  if (!created?.customer) throw new Error("Failed to create customer");
  return created.customer;
}

async function createOrder({ locationId, customerId, per, guests, taxRate, travel, tip, note }) {
  function safeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
const idempotency = safeId();

  // Define a single order-level tax and apply it to the package line via applied_taxes
  const TAX_UID = "ma-tax";

  const body = {
    idempotency_key: idempotency,
    order: {
      location_id: locationId,
      customer_id: customerId,

      // Order-level tax definition (ADDITIVE percentage)
      taxes: [
        {
          uid: TAX_UID,
          name: "Sales Tax",
          type: "ADDITIVE",
          percentage: String(taxRate * 100), // e.g., 6.25
          scope: "LINE_ITEM"
        }
      ],

      line_items: [
        {
          name: "Package",
          quantity: String(guests),
          base_price_money: money(per),
          // Apply the above tax to this line
          applied_taxes: [ { tax_uid: TAX_UID } ]
        },
        {
          name: "Travel Fee",
          quantity: "1",
          base_price_money: money(travel)
        },
        {
          name: "Tip (18%)",
          quantity: "1",
          base_price_money: money(tip)
        }
      ],
      note
    }
  };

  const resp = await fetch(`${SQUARE_BASE}/v2/orders`, {
    method: "POST",
    headers: reqHeaders({ "Idempotency-Key": idempotency }),
    body: JSON.stringify(body)
  }).then(r => r.json());

  if (!resp?.order?.id) throw new Error("Failed to create order: " + JSON.stringify(resp));
  return resp.order;
}

async function createInvoice({ orderId, customerId }) {
  const body = {
    invoice: {
      location_id: process.env.SQUARE_LOCATION_ID,
      order_id: orderId,
      primary_recipient: { customer_id: customerId },
      delivery_method: "EMAIL",
      title: "The Cravery — Catering Estimate (Sandbox)",
      description: "This is a sandbox estimate generated automatically.",
      payment_requests: [
        { request_type: "BALANCE", due_date: new Date(Date.now() + 7*24*3600*1000).toISOString().slice(0,10) }
      ],
      accepted_payment_methods: { card: true }
    }
  };

  const resp = await fetch(`${SQUARE_BASE}/v2/invoices`, {
    method: "POST",
    headers: reqHeaders(),
    body: JSON.stringify(body)
  }).then(r => r.json());

  if (!resp?.invoice?.id) throw new Error("Failed to create invoice: " + JSON.stringify(resp));
  return resp.invoice;
}

async function publishInvoice(invoiceId, version = 1) {
  const resp = await fetch(`${SQUARE_BASE}/v2/invoices/${invoiceId}/publish`, {
    method: "POST",
    headers: reqHeaders(),
    body: JSON.stringify({ version })
  }).then(r => r.json());

  if (!resp?.invoice?.id) throw new Error("Failed to publish invoice: " + JSON.stringify(resp));
  return resp.invoice;
}

// --- Owner notification via Formspree (simple) ---
async function sendOwnerNotification({ endpoint, ownerEmail, name, email, event_address, miles, per, guests, totals, invoiceUrl, invoiceId }) {
  const summary = [
    `New quote: ${name} <${email}>`,
    event_address ? `Event: ${event_address}` : null,
    `Miles: ${miles.toFixed(1)}`,
    `Package: $${per.toFixed(2)} x ${guests}`,
    `Items: $${totals.items.toFixed(2)}, Tax: $${totals.tax.toFixed(2)}`,
    `Travel: $${totals.travel.toFixed(2)}, Tip: $${totals.tip.toFixed(2)}`,
    `Total Before Tip: $${totals.totalBeforeTip.toFixed(2)}`,
    `FINAL: $${totals.finalTotal.toFixed(2)}`,
    `Invoice: ${invoiceUrl || invoiceId}`
   ].filter(Boolean).join("\n");

  await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Cravery Quotes Bot",
      email: ownerEmail,
      message: summary
    })
  });
}
