export const config = {
  api: {
    bodyParser: true, // Vercel default is fine unless PayPal sends a raw stream
  },
};

export default async function handler(req, res) {
  console.log('Webhook function invoked', {
    method: req.method,
    url: req.url,
    headers: req.headers,
  });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { event_type, resource } = req.body;

    if (event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
      console.log('Ignoring non-payment event:', event_type);
      return res.status(200).json({ status: 'ignored' });
    }

    // Extract relevant details from PayPal webhook payload
    const email = resource?.payer?.email_address;
    const paypal_order_id = resource?.id;
    const amount_paid = resource?.amount?.value;
    const payment_received_at = resource?.create_time || new Date().toISOString();
    const account_type = 'velvet_library'; // Hardcoded for now, can customize later

    if (!email || !paypal_order_id || !amount_paid) {
      return res.status(400).json({ error: 'Missing required PayPal fields' });
    }

    // Call Supabase REST API to insert or update user
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/users`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({
        email,
        paypal_order_id,
        amount_paid,
        account_type,
        payment_received_at,
        has_paid: true, // Set paid flag
        created_at: new Date().toISOString(),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Supabase error:', data);
      return res.status(500).json({ error: 'Failed to insert user' });
    }

    return res.status(200).json({ success: true, user: data });
  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
