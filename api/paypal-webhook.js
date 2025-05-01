import fetch from 'node-fetch'; // Assuming node-fetch is available in Vercel environment

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
    // Log body for debugging, but be cautious with sensitive data in production logs
    // body: req.body,
  });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { event_type, resource } = req.body;

    console.log('Received event type:', event_type);

    let email = null;
    let paypal_order_id = null;
    let amount_paid = null;
    let payment_received_at = null;
    let account_type = null;
    let subscription_id = null; // New variable for subscription ID
    let subscription_status = null; // New variable for subscription status
    let next_billing_date = null; // New variable for next billing date

    // --- Logic to handle different event types ---

    // Handle One-Time Payment Completion (e.g., from simple button or Orders API capture)
    // Common events: PAYMENT.CAPTURE.COMPLETED, PAYMENT.SALE.COMPLETED, checkout.order.completed
    if (event_type === 'PAYMENT.CAPTURE.COMPLETED' || event_type === 'PAYMENT.SALE.COMPLETED' || event_type === 'checkout.order.completed') {
      console.log('Processing one-time payment completion event');
      email = resource?.payer?.email_address;
      paypal_order_id = resource?.id || resource?.purchase_units?.[0]?.payments?.captures?.[0]?.id || resource?.resource?.id; // Handle variations in payload structure
      amount_paid = resource?.amount?.value || resource?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value; // Handle variations
      payment_received_at = resource?.create_time || resource?.update_time || new Date().toISOString();
      account_type = 'one_time'; // Set account type for one-time purchase

      if (!email || !paypal_order_id || !amount_paid) {
         console.error('Missing required fields for one-time payment event', { email, paypal_order_id, amount_paid, resource });
         return res.status(400).json({ error: 'Missing required PayPal fields for one-time payment' });
      }

      // For one-time payments, we might just insert/update the user record
      // and set a flag like `has_paid` or rely on `account_type`.
      // We don't need subscription-specific fields here.

    }
    // Handle Subscription Related Events
    // Common events: BILLING.SUBSCRIPTION.CREATED, BILLING.SUBSCRIPTION.ACTIVATED,
    // BILLING.SUBSCRIPTION.PAYMENT.COMPLETED, BILLING.SUBSCRIPTION.CANCELLED, etc.
    else if (event_type.startsWith('BILLING.SUBSCRIPTION.')) {
        console.log('Processing subscription related event:', event_type);

        // Payload structure for subscriptions is different
        subscription_id = resource?.id;
        email = resource?.subscriber?.email_address;
        subscription_status = resource?.status; // e.g., 'APPROVAL_PENDING', 'ACTIVE', 'CANCELLED', 'EXPIRED'
        account_type = 'monthly_subscription'; // Set account type for subscription

        // For PAYMENT.COMPLETED events within a subscription, you might find payment details
        if (event_type === 'BILLING.SUBSCRIPTION.PAYMENT.COMPLETED') {
            amount_paid = resource?.amount?.value; // Amount of the recurring payment
            payment_received_at = resource?.create_time || new Date().toISOString();
            // You might also get next_billing_date from the resource if available, or calculate it.
            // The resource structure for PAYMENT.COMPLETED might link back to the subscription object.
            // You might need to fetch the subscription details using the subscription_id if needed.
            // For simplicity here, we'll rely on the BILLING.SUBSCRIPTION.CREATED/ACTIVATED event for initial setup.
            // For subsequent payments, we'd update the last_payment_date and potentially next_billing_date.
        } else if (event_type === 'BILLING.SUBSCRIPTION.CREATED' || event_type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
             // When a subscription is created or activated, extract initial details
             // The resource for CREATED/ACTIVATED events contains details about the plan and start date
             payment_received_at = resource?.start_time || new Date().toISOString(); // Start date of the subscription
             subscription_status = resource?.status; // Should be 'ACTIVE' for ACTIVATED event
             next_billing_date = resource?.billing_info?.next_billing_time; // Next payment date

             // The amount for the first payment might be in a related event or resource property
             // For simplicity, you might get the plan amount from your own database based on the plan ID
             // or rely on the first PAYMENT.COMPLETED event. Let's assume amount_paid is set by PAYMENT.COMPLETED
             amount_paid = null; // Or fetch plan amount if needed
        }
        // Add cases for other subscription events like CANCELLED, SUSPENDED, EXPIRED etc.
        // For CANCELLED, you'd update subscription_status to 'CANCELLED' in your DB.

        if (!subscription_id || !email || !subscription_status) {
             console.error('Missing required fields for subscription event', { subscription_id, email, subscription_status, resource });
             return res.status(400).json({ error: 'Missing required PayPal fields for subscription event' });
        }

        // For subscriptions, we need to update subscription-specific fields
        // The Supabase call logic below will need to handle inserting/updating
        // based on whether a user with this subscription_id already exists,
        // or finding the user by email and updating their subscription details.

    } else {
      console.log('Ignoring unhandled event type:', event_type);
      return res.status(200).json({ status: 'ignored', message: `Unhandled event type: ${event_type}` });
    }

    // --- Supabase Interaction ---

    // Determine the unique identifier to find/create the user record.
    // For one-time, email is the primary link.
    // For subscriptions, subscription_id is unique to the subscription, but email links to the user.
    // You might need to find by email first, then update, or use `onConflict` if Supabase supports it on email.

    // Example Supabase call - needs adjustment based on your exact Supabase setup
    // and how you link PayPal users to your auth_user_id.
    // This example attempts to find by email and update/insert.

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use service role key for server-side operations

    if (!supabaseUrl || !supabaseServiceRoleKey) {
        console.error('Supabase environment variables not set.');
        return res.status(500).json({ error: 'Server configuration error: Supabase keys missing.' });
    }


    // First, try to find the user by email
    const findUserResponse = await fetch(`${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: {
        'apikey': supabaseServiceRoleKey,
        'Authorization': `Bearer ${supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
      },
    });

    const existingUsers = await findUserResponse.json();

    if (!findUserResponse.ok) {
       console.error('Supabase find user error:', existingUsers);
       return res.status(500).json({ error: 'Failed to query Supabase for user.' });
    }

    let userDataToSave = {
      email: email,
      account_type: account_type,
      payment_received_at: payment_received_at, // Timestamp of this specific payment/event
      last_payment_date: payment_received_at, // Update last payment date on payment events
      // Keep existing created_at if updating, set new if inserting
      ...(existingUsers.length === 0 && { created_at: new Date().toISOString() }),
    };

    // Add fields specific to the event type
    if (account_type === 'one_time') {
        userDataToSave = {
            ...userDataToSave,
            paypal_order_id: paypal_order_id,
            amount_paid: amount_paid,
            // For one-time, maybe set a simple flag or rely on account_type === 'one_time'
            // has_paid: true, // If you still want this flag
        };
    } else if (account_type === 'monthly_subscription') {
        userDataToSave = {
            ...userDataToSave,
            subscription_id: subscription_id,
            subscription_status: subscription_status,
            // amount_paid might be null for non-payment subscription events (CREATED, ACTIVATED)
            ...(amount_paid !== null && { amount_paid: amount_paid }), // Only update amount if it's a payment event
            ...(next_billing_date !== null && { next_billing_date: next_billing_date }), // Only update if available
            // For subscriptions, `has_paid` logic is more complex, depends on `subscription_status`
            // has_paid: subscription_status === 'ACTIVE', // Example logic
        };
    }

    let supabaseResponse;
    let supabaseData;

    if (existingUsers.length > 0) {
      // User exists, update their record (assuming email is unique)
      const userId = existingUsers[0].id; // Get the Supabase user ID
      console.log('User found in Supabase, attempting to update:', userId);

      supabaseResponse = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}`, {
        method: 'PATCH', // Use PATCH to update
        headers: {
          'apikey': supabaseServiceRoleKey,
          'Authorization': `Bearer ${supabaseServiceRoleKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation', // Return the updated record
        },
        body: JSON.stringify(userDataToSave),
      });

      supabaseData = await supabaseResponse.json();
      console.log('Supabase update response:', supabaseData);

    } else {
      // User does not exist, insert a new record
      console.log('User not found in Supabase, attempting to insert.');

      supabaseResponse = await fetch(`${supabaseUrl}/rest/v1/users`, {
        method: 'POST', // Use POST to insert
        headers: {
          'apikey': supabaseServiceRoleKey,
          'Authorization': `Bearer ${supabaseServiceRoleKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation', // Return the inserted record
        },
        body: JSON.stringify(userDataToSave),
      });

      supabaseData = await supabaseResponse.json();
      console.log('Supabase insert response:', supabaseData);
    }


    if (!supabaseResponse.ok) {
      console.error('Supabase operation error:', supabaseData);
      // Log the data sent to Supabase for debugging
      console.error('Data sent to Supabase:', userDataToSave);
      return res.status(500).json({ error: `Failed to process user in Supabase. Status: ${supabaseResponse.status}` });
    }

    console.log('Successfully processed webhook and updated Supabase.');
    return res.status(200).json({ success: true, user: supabaseData });

  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}
