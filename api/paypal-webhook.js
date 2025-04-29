// api/paypal-webhook.js

export default async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  
    try {
      const { email, paypal_order_id, amount_paid, account_type } = req.body;
  
      if (!email || !paypal_order_id || !amount_paid || !account_type) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
  
      const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/users`, {
        method: 'POST',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({
          email,
          paypal_order_id,
          amount_paid,
          account_type,
          payment_received_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }),
      });
  
      const data = await response.json();
  
      if (!response.ok) {
        console.error('Supabase error:', data);
        return res.status(500).json({ error: 'Failed to insert user' });
      }
  
      res.status(200).json({ success: true, user: data });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
  