/// import fetch from 'node-fetch'; // Commented out as using dynamic import

// REMOVE bodyParser config as we will manually parse
export const config = {
  api: {
    // bodyParser: true, // Remove this line
  },
};

export default async function handler(req, res) {
  // Dynamic import node-fetch for making HTTP calls (to Supabase)
  const fetch = (await import('node-fetch')).default;
  // Dynamic import buffer utility from micro to read the raw request body
  const { buffer } = await import('micro'); // micro is often available in Vercel functions

  console.log('Webhook function invoked', {
    method: req.method,
    url: req.url,
    headers: req.headers,
    // req.body is undefined now, manual parsing needed
    // body: req.body, // Do not log req.body here
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
    // Manually read the raw request body stream
    const rawBody = await buffer(req);
    // Convert buffer to string and parse JSON
    // Check if rawBody is empty or not valid before parsing
    const body = rawBody.length > 0 ? JSON.parse(rawBody.toString()) : {}; // Handle potentially empty body

    console.log('Manually parsed request body:', body); // Log the parsed body - **Still hoping this appears**

    // Now destructure from the manually parsed body
    const { event_type, resource } = body; // Destructure from the parsed body

    // Check if event_type and resource were successfully extracted
    if (!event_type || !resource) {
        console.error('Could not extract event_type or resource from body:', body);
        // Return 400 if essential data structure is missing
        return res.status(400).json({ error: 'Invalid PayPal webhook payload structure', receivedBody: body });
    }

    console.log('Received event type:', event_type); // This log should now appear if parsing works

    // ... (rest of variable initializations) ...
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
      // --- UPDATED EXTRACTION LOGIC FOR ONE-TIME PAYMENTS ---
      // Added more fallback paths for email and paypal_order_id based on different payload structures
      email = resource?.payer?.email_address || body?.resource?.payer?.email_address || body?.payer?.email_address || resource?.supplementary_data?.payer?.email_address || resource?.order?.payer?.email_address || body?.purchase_units?.[0]?.payments?.[0]?.captures?.[0]?.payer?.email_address || resource?.email; // Added more common paths including resource.email
      paypal_order_id = resource?.id || resource?.purchase_units?.[0]?.payments?.[0]?.captures?.[0]?.id || resource?.resource?.id || resource?.supplementary_data?.related_ids?.order_id || resource?.order_id || resource?.checkout_order?.id; // Added supplementary_data and other potential paths
      amount_paid = resource?.amount?.value || resource?.purchase_units?.[0]?.payments?.[0]?.captures?.[0]?.amount?.value || resource?.gross_amount?.value; // Added gross_amount fallback
      payment_received_at = resource?.create_time || resource?.update_time || new Date().toISOString(); // Timestamp
      account_type = 'one_time'; // Set account type for one-time purchase
      // --- END UPDATED EXTRACTION ---

      // --- Explicitly log the result of the required fields check ---
      const missingOneTimeFields = !email || !paypal_order_id || !amount_paid;
      console.log('One-Time Required Fields Check Result:', missingOneTimeFields, { email, paypal_order_id, amount_paid });
      // --- End Explicit Log ---


      if (missingOneTimeFields) { // Use the variable from the explicit log
         console.error('Missing required fields for one-time payment event after extraction attempts:', { email, paypal_order_id, amount_paid, resource }); // Log what was found/missing
         // Keeping the 200 return with skipped status
      } else {
           console.log('Extracted One-Time Data:', { email, paypal_order_id, amount_paid, payment_received_at, account_type }); // Log success
           // If successful, the code would proceed to Supabase... but the skip check below will catch it
       }

    }
    // Handle Subscription Related Events
    // Common events: BILLING.SUBSCRIPTION.CREATED, BILLING.SUBSCRIPTION.ACTIVATED,
    // BILLING.SUBSCRIPTION.PAYMENT.COMPLETED, BILLING.SUBSCRIPTION.CANCELLED, UPDATED, SUSPENDED, EXPIRED, PAYMENT.FAILED
     else if (event_type.startsWith('BILLING.SUBSCRIPTION.')) {
        console.log('Processing subscription related event:', event_type);

        // Attempt to extract common subscription fields from various potential locations
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
            // Let's rely on the PAYMENT.SUBSCRIPTION.PAYMENT.COMPLETED event for setting amount_paid/last_payment_amount
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
            // It might be better to still return 200 OK here for PayPal retries, but log the error
            // return res.status(400).json({ error: 'Missing essential PayPal fields for subscription event' });
        } else {
            console.log('Extracted Subscription Data:', { subscription_id, email, subscription_status, next_billing_date, last_payment_date, last_payment_amount });
        }

    } else {
      console.log('Ignoring unhandled event type:', event_type);
      // Always return 200 OK for unhandled events so PayPal doesn't retry excessively
      return res.status(200).json({ status: 'ignored', message: `Unhandled event type: ${event_type}` });
    }

    // If essential fields were missing, we logged an error and might want to stop processing the Supabase update
    // Add a check here before proceeding to Supabase
    if (account_type === 'one_time') {
        const missingOneTimeFields = !email || !paypal_order_id || !amount_paid; // Re-calculate or use the variable
        if (missingOneTimeFields) {
             console.error('Skipping Supabase update due to missing One-Time fields.'); // <--- This log should appear
             return res.status(200).json({ status: 'skipped', message: 'Missing required fields for one-time payment, skipping Supabase update' });
        }
    } else if (account_type === 'monthly_subscription') { // Check for subscription missing fields
        const missingSubscriptionFields = !subscription_id || !email || !subscription_status; // Re-calculate or use the variable
        if (missingSubscriptionFields) {
             console.error('Skipping Supabase update due to missing Subscription essential fields.'); // <--- This log should appear
             return res.status(200).json({ status: 'skipped', message: 'Missing essential PayPal fields for subscription event, skipping Supabase update' });
        }
    }
    // Also skip if event_type was unhandled (this is redundant with the else block return, but harmless)
    if (!account_type) { // account_type is set only for handled events
         console.log('Skipping Supabase update for unhandled event type.');
         // This case is already handled by the else block returning 200, but adding for clarity
          return res.status(200).json({ status: 'ignored', message: `Unhandled event type: ${event_type}, skipping Supabase update` });
    }


    // --- Supabase Interaction ---
    // The logic here seems generally okay - find user by email, then update or insert.
    // We just need to ensure the `userDataToSave` object includes the correct fields
    // based on the `account_type` and the data successfully extracted above.

    // --- Debugging process.env access --- // Add these logs back
    console.log('--- Debugging process.env access ---');
    console.log('Is process defined?', typeof process !== 'undefined');
    if (typeof process !== 'undefined') {
        console.log('Is process.env defined?', typeof process.env !== 'undefined');
        if (typeof process.env !== 'undefined') {
             // Be cautious logging all keys in production, but useful for debugging
             // console.log('process.env keys:', Object.keys(process.env)); // Uncomment with caution
             console.log('SUPABASE_URL from process.env:', process.env.SUPABASE_URL ? 'Defined' : 'Undefined');
             console.log('SUPABASE_SERVICE_ROLE_KEY from process.env:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Defined' : 'Undefined');
        } else {
             console.error('process.env is NOT defined.'); // Should not happen in Node.js
        }
    } else {
        console.error('process is NOT defined.'); // Should not happen in Node.js
    }
     console.log('--- End Debugging process.env access ---'); // End logs

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceRoleKey) {
        console.error('Supabase environment variables not set.');
        // Return 500 because this is a server config issue, PayPal might retry
        return res.status(500).json({ error: 'Server configuration error: Supabase keys missing.' });
    }

    // First, try to find the user by email
    const findUserResponse = await fetch(`<span class="math-inline">\{supabaseUrl\}/rest/v1/users?email\=eq\.</span>{encodeURIComponent(email)}`, {
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
       // Return 500 as this is a server issue
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
            // For one-time, maybe set a simple flag like `has_paid` or rely on `account_type`
            has_paid: true, // Set has_paid to true for one-time payment success
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
            has_paid: subscription_status === 'ACTIVE' || subscription_status === 'CREATED' || subscription_status === 'APPROVAL_PENDING', // Set has_paid based on active/pending status
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

      supabaseResponse = await fetch(`<span class="math-inline">\{supabaseUrl\}/rest/v1/users?id\=eq\.</span>{userId}`, {
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
        body: JSON.stringify(userDataTo
