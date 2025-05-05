// import fetch from 'node-fetch'; // Yeh purani import line comment out kar diya

export const config = {
    api: {
      bodyParser: true,
    },
  };
  
  export default async function handler(req, res) {
    // Nayi dynamic import line yahan add kiya
    // Isko await karna zaroori hai kyunki dynamic import asynchronous hota hai
    // .default property use karte hain kyunki node-fetch ES Module hai
    const fetch = (await import('node-fetch')).default;
  
    console.log('Webhook function invoked', {
      method: req.method,
      url: req.url,
      headers: req.headers,
      // Log body for debugging, but be cautious with sensitive data in production logs
      // body: req.body, // Uncomment carefully
    });
  
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  
    // **SECURITY WARNING:**
    // In a real-world application, you MUST verify the webhook signature
    // to ensure the request is genuinely from PayPal. This code does NOT include
    // signature verification. You would typically get the signature from headers
    // (e.g., 'paypal-transmission-sig') and verify it using PayPal's API or SDK.
    // Example: https://developer.paypal.com/api/rest/webhooks/verify-event/
  
    try {
      const { event_type, resource } = req.body;
  
      console.log('Received event type:', event_type);
      // console.log('Received resource:', JSON.stringify(resource, null, 2)); // Log resource for debugging payload structure
  
      let email = null;
      let paypal_order_id = null; // Used for one-time payments
      let amount_paid = null;
      let payment_received_at = null; // Timestamp of the specific event
      let account_type = null;
  
      // Subscription specific fields
      let subscription_id = null;
      let subscription_status = null;
      let next_billing_date = null;
      let last_payment_date = null; // To store the date of the last payment event
      let last_payment_amount = null; // To store the amount of the last payment event
  
      // --- Logic to handle different event types ---
  
      // Handle One-Time Payment Completion (e.g., from simple button, Orders API capture)
      // Common events: PAYMENT.CAPTURE.COMPLETED, PAYMENT.SALE.COMPLETED, checkout.order.completed
      if (event_type === 'PAYMENT.CAPTURE.COMPLETED' || event_type === 'PAYMENT.SALE.COMPLETED' || event_type === 'checkout.order.completed') {
        console.log('Processing one-time payment completion event');
        email = resource?.payer?.email_address;
        paypal_order_id = resource?.id || resource?.purchase_units?.[0]?.payments?.captures?.[0]?.id || resource?.resource?.id; // Handle variations in payload structure
        amount_paid = resource?.amount?.value || resource?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value; // Handle variations
        payment_received_at = resource?.create_time || resource?.update_time || new Date().toISOString(); // Timestamp of this event
        account_type = 'one_time'; // Set account type for one-time purchase
  
        if (!email || !paypal_order_id || !amount_paid) {
           console.error('Missing required fields for one-time payment event', { email, paypal_order_id, amount_paid, resource });
           return res.status(400).json({ error: 'Missing required PayPal fields for one-time payment' });
        }
  
        // For one-time payments, we will insert/update the user record
        // based on email, setting account_type, payment details.
  
      }
      // Handle Subscription Related Events
      // Common events: BILLING.SUBSCRIPTION.CREATED, BILLING.SUBSCRIPTION.ACTIVATED,
      // BILLING.SUBSCRIPTION.PAYMENT.COMPLETED, BILLING.SUBSCRIPTION.CANCELLED, UPDATED, SUSPENDED, EXPIRED, PAYMENT.FAILED
      else if (event_type.startsWith('BILLING.SUBSCRIPTION.')) {
          console.log('Processing subscription related event:', event_type);
  
          // Attempt to extract common subscription fields from various potential locations
          // Use || to check alternative common paths for the same data point
          subscription_id = resource?.id || resource?.billing_agreement_id; // ID might be in 'id' or 'billing_agreement_id'
          email = resource?.subscriber?.email_address || resource?.payer?.payer_info?.email || resource?.payer?.email_address; // Email can be in different places
          subscription_status = resource?.status || resource?.state; // Status might be in 'status' or 'state'
  
          // Set account type for subscription
          account_type = 'monthly_subscription';
  
          // Handle event-specific data extraction
          payment_received_at = resource?.create_time || resource?.update_time || resource?.start_time || new Date().toISOString(); // Use a general event timestamp
  
          if (event_type === 'BILLING.SUBSCRIPTION.PAYMENT.COMPLETED') {
              console.log('Processing BILLING.SUBSCRIPTION.PAYMENT.COMPLETED specific details');
              amount_paid = resource?.amount?.value; // Amount of THIS payment cycle
              last_payment_amount = amount_paid; // Store this as the last payment amount
              last_payment_date = resource?.create_time || new Date().toISOString(); // Store the time of THIS payment
              // next_billing_date is typically in CREATED/ACTIVATED/UPDATED events, not PAYMENT.COMPLETED
          } else if (event_type === 'BILLING.SUBSCRIPTION.CREATED' || event_type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
              console.log('Processing BILLING.SUBSCRIPTION.CREATED/ACTIVATED specific details');
              // The subscription start date is important, captured by payment_received_at above (if start_time exists)
              next_billing_date = resource?.billing_info?.next_billing_time; // Next billing date is key here
              // amount_paid for the first cycle might be available, but PAYMENT.COMPLETED event is more reliable for payment amount
              // Let's rely on the PAYMENT.COMPLETED event for setting amount_paid/last_payment_amount
          } else if (event_type === 'BILLING.SUBSCRIPTION.UPDATED') {
               console.log('Processing BILLING.SUBSCRIPTION.UPDATED specific details');
               // Common fields like ID, email, status/state are already handled by ORs above
               // Check for specific updates like next_billing_date or last payment info IF they are part of the update payload
               next_billing_date = resource?.billing_info?.next_billing_time || next_billing_date; // Update next_billing_date if present in update
               last_payment_amount = resource?.agreement_details?.last_payment_amount?.value || last_payment_amount; // Update last payment amount if present
               last_payment_date = resource?.agreement_details?.last_payment_date || last_payment_date; // Update last payment date if present
  
           }
           // For CANCELLED, SUSPENDED, EXPIRED, PAYMENT.FAILED etc., the common extraction for ID, email, status is usually enough.
           // You might log or add specific handling if needed for these states (e.g., send a notification email to the user).
  
  
          // Now, check for REQUIRED essential fields after attempting extraction from all potential places
          if (!subscription_id || !email || !subscription_status) {
              console.error('Missing essential fields for subscription event after extraction attempts', { subscription_id, email, subscription_status, resource });
              return res.status(400).json({ error: 'Missing essential PayPal fields for subscription event' });
          }
  
           // We have successfully extracted essential subscription data.
           // Proceed to Supabase interaction.
           // The Supabase data structure will need to accommodate subscription fields.
  
      } else {
        console.log('Ignoring unhandled event type:', event_type);
        return res.status(200).json({ status: 'ignored', message: `Unhandled event type: ${event_type}` });
      }
  
      // --- Supabase Interaction ---
      // The logic here seems generally okay - find user by email, then update or insert.
      // We just need to ensure the `userDataToSave` object includes the correct fields
      // based on the `account_type` and the data successfully extracted above.
  
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
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
        // Use payment_received_at as the timestamp for THIS specific event
        payment_received_at: payment_received_at,
        // created_at should only be set on initial insert
        ...(existingUsers.length === 0 && { created_at: new Date().toISOString() }),
        // You might want an 'updated_at' timestamp as well
        updated_at: new Date().toISOString(),
      };
  
      // Add fields specific to the account type and the data extracted
      if (account_type === 'one_time') {
          userDataToSave = {
              ...userDataToSave,
              paypal_order_id: paypal_order_id,
              // amount_paid is the amount of the one-time payment
              amount_paid: amount_paid,
              // For one-time, maybe set a simple flag like `is_premium` or rely on `account_type`
              // is_premium: true, // Example based on successful one-time payment
          };
      } else if (account_type === 'monthly_subscription') {
          userDataToSave = {
              ...userDataToSave,
              subscription_id: subscription_id,
              subscription_status: subscription_status,
              // Only include subscription payment details if they were captured from a PAYMENT.COMPLETED event
              ...(last_payment_amount !== null && { last_payment_amount: last_payment_amount }),
              ...(last_payment_date !== null && { last_payment_date: last_payment_date }),
              // Only include next_billing_date if it was captured (e.g., from CREATED/ACTIVATED/UPDATED)
              ...(next_billing_date !== null && { next_billing_date: next_billing_date }),
  
              // Decide how `amount_paid` column should be used for subscriptions.
              // If it means "amount of the most recent payment", set it from last_payment_amount.
              // If it's not needed for subscriptions, remove this line.
              // Let's keep `last_payment_amount` and `last_payment_date` separate for clarity.
              // Consider if you need a simple flag like `is_active_subscriber` derived from `subscription_status`.
              is_active_subscriber: subscription_status === 'ACTIVE', // Example flag
          };
          // You might need to adjust your Supabase 'users' table schema to include
          // `subscription_id`, `subscription_status`, `next_billing_date`, `last_payment_date`,
          // `last_payment_amount`, `is_active_subscriber` fields.
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
  
        // Supabase PATCH/PUT/DELETE typically returns an array of affected rows (usually 1)
        supabaseData = await supabaseResponse.json();
        console.log('Supabase update response:', supabaseData);
  
      } else {
        // User does not exist, insert a new record
        console.log('User not found in Supabase, attempting to insert.');
  
        // Ensure the data has all necessary fields for a new user record in your schema
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
  
        // Supabase POST typically returns an array containing the new record(s)
        supabaseData = await supabaseResponse.json();
        console.log('Supabase insert response:', supabaseData);
      }
  
  
      if (!supabaseResponse.ok || supabaseData.length === 0) {
        console.error('Supabase operation failed or returned no data:', supabaseData);
        console.error('Data sent to Supabase:', userDataToSave);
        return res.status(500).json({ error: `Failed to process user in Supabase. Status: ${supabaseResponse.status}` });
      }
  
      console.log('Successfully processed webhook and updated Supabase.');
      // Return the successfully processed user data
      return res.status(200).json({ success: true, user: supabaseData[0] || supabaseData });
  
    } catch (error) {
      console.error('Webhook handler error:', error);
      // Log the request body here if possible for debugging severe errors, be cautious with sensitive data
      // console.error('Request body that caused error:', req.body);
      return res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
  }