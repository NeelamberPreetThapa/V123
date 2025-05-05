// import fetch from 'node-fetch'; // Commented out as using dynamic import

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

    console.log('Manually parsed request body:', body); // Log the parsed body

    // Now destructure from the manually parsed body
    const { event_type, resource } = body; // Destructure from the parsed body

    // Check if event_type and resource were successfully extracted
    if (!event_type || !resource) {
        console.error('Could not extract event_type or resource from body:', body);
        // Return 400 if essential data structure is missing
        return res.status(400).json({ error: 'Invalid PayPal webhook payload structure', receivedBody: body });
    }

    console.log('Received event type:', event_type); // This log should now appear if parsing works

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
      email = resource?.payer?.email_address; // Common path, but might need more fallbacks
      // Corrected path for ID/Amount in nested purchase_units/payments/captures
      paypal_order_id = resource?.id || resource?.purchase_units?.[0]?.payments?.[0]?.captures?.[0]?.id || resource?.resource?.id;
      amount_paid = resource?.amount?.value || resource?.purchase_units?.[0]?.payments?.[0]?.captures?.[0]?.amount?.value;
      payment_received_at = resource?.create_time || resource?.update_time || new Date().toISOString(); // Timestamp of this event
      account_type = 'one_time'; // Set account type for one-time purchase

      if (!email || !paypal_order_id || !amount_paid) {
         console.error('Missing required fields for one-time payment event', { email, paypal_order_id, amount_paid, resource });
         // It might be better to still return 200 OK here for PayPal retries, but log the error
           // return res.status(400).json({ error: 'Missing required PayPal fields for one-time payment' });
      } else {
           console.log('Extracted One-Time Data:', { email, paypal_order_id, amount_paid, payment_received_at, account_type });
       }

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
    if (account_type === 'one_time' && (!email || !paypal_order_id || !amount_paid)) {
        console.error('Skipping Supabase update due to missing One-Time fields.');
        // Return 200 OK so PayPal doesn't retry a problematic payload endlessly
        return res.status(200).json({ status: 'skipped', message: 'Missing required fields for one-time payment, skipping Supabase update' });
    }
     if (account_type === 'monthly_subscription' && (!subscription_id || !email || !subscription_status)) {
        console.error('Skipping Supabase update due to missing Subscription essential fields.');
         // Return 200 OK so PayPal doesn't retry a problematic payload endlessly
        return res.status(200).json({ status: 'skipped', message: 'Missing essential PayPal fields for subscription event, skipping Supabase update' });
    }
    // Also skip if event_type was unhandled
    if (!account_type) { // account_type is set only for handled events
         console.log('Skipping Supabase update for unhandled event type.');
         // This case is already handled by the else block returning 200, but adding for clarity
          return res.status(200).json({ status: 'ignored', message: `Unhandled event type: ${event_type}, skipping Supabase update` });
    }


    // --- Supabase Interaction ---
    // The logic here seems generally okay - find user by email, then update or insert.
    // We just need to ensure the `userDataToSave` object includes the correct fields
    // based on the `account_type` and the data successfully extracted above.

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process