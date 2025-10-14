export default async function handler(req, res) {
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

  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
  const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
  const OWNER_EMAIL = process.env.OWNER_EMAIL;

  if (!name || !email) {
    return res.status(400).json({ error: "Missing name or email" });
  }

  const per = parseFloat(package_rate || 0);
  const guestCount = parseInt(guests || 0, 10);
  const milesNum = parseFloat(miles || 0);

  const TAX_RATE = 0.0625, TIP_RATE = 0.18, TRAVEL_BASE = 50, PER_MILE = 4;
  const items = per * guestCount;
  const tax = TAX_RATE * items;
  const travel = TRAVEL_BASE + PER_MILE * milesNum;
  const tip = TIP_RATE * items;
  const totalBeforeTip = travel + (items + tax);
  const finalTotal = totalBeforeTip + tip;

  console.log("✅ Quote received:", { name, email, event_address, total: finalTotal });

  return res.status(200).json({
    success: true,
    message: "Quote received successfully.",
    name,
    email,
    event_address,
    guests: guestCount,
    totals: { items, tax, travel, tip, totalBeforeTip, finalTotal }
  });
}
