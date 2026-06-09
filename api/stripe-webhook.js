// ════════════════════════════════════════════════════════════════
//  POST /api/stripe-webhook
//  Stripe envoie ses events ici. On vérifie la signature avec
//  STRIPE_WEBHOOK_SECRET, puis on synchronise la table subscriptions
//  via la service_role key (qui bypasse la RLS).
//
//  Events gérés :
//   - checkout.session.completed
//   - customer.subscription.updated
//   - customer.subscription.deleted
//
//  ⚠️ IMPORTANT : Stripe a besoin du body BRUT (non parsé) pour
//  vérifier la signature. D'où le bodyParser désactivé.
// ════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Désactive le body parser de Vercel pour lire le raw body
export const config = {
  api: { bodyParser: false }
};

// Lecture manuelle du raw body (évite d'ajouter la dep `micro`)
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Helper : retrouve le user_id, soit depuis les metadata, soit en lookup par customer_id
async function resolveUserId({ metadataUserId, customerId, clientReferenceId }) {
  if (clientReferenceId) return clientReferenceId;
  if (metadataUserId)    return metadataUserId;
  if (customerId) {
    const { data } = await supabaseAdmin
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    return data?.user_id || null;
  }
  return null;
}

async function upsertSubscription(userId, fields) {
  if (!userId) {
    console.error('[webhook] userId manquant — update annulé', fields);
    return;
  }
  const { error } = await supabaseAdmin
    .from('subscriptions')
    .update(fields)
    .eq('user_id', userId);
  if (error) console.error('[webhook] update subscriptions failed', error);
  else console.log('[webhook] subscriptions mis à jour pour', userId, fields);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).send('Missing stripe-signature');

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('[webhook] event reçu :', event.type, event.id);

  try {
    switch (event.type) {

      // ─── 1) Checkout terminé → on stocke customer + subscription IDs ───
      case 'checkout.session.completed': {
        const session = event.data.object;

        const userId = await resolveUserId({
          clientReferenceId: session.client_reference_id,
          metadataUserId:    session.metadata?.user_id,
          customerId:        session.customer,
        });

        // On va chercher l'objet subscription pour avoir son vrai status (au cas où)
        let stripeStatus = 'active';
        if (session.subscription) {
          const fullSub = await stripe.subscriptions.retrieve(session.subscription);
          stripeStatus = fullSub.status;
        }

        await upsertSubscription(userId, {
          status:                 stripeStatus,
          stripe_customer_id:     session.customer || null,
          stripe_subscription_id: session.subscription || null,
        });
        break;
      }

      // ─── 2) Subscription modifiée (upgrade, downgrade, paiement renouvelé…) ───
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = await resolveUserId({
          metadataUserId: sub.metadata?.user_id,
          customerId:     sub.customer,
        });
        await upsertSubscription(userId, {
          status:                 sub.status,
          stripe_customer_id:     sub.customer,
          stripe_subscription_id: sub.id,
        });
        break;
      }

      // ─── 3) Subscription annulée / supprimée ───
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = await resolveUserId({
          metadataUserId: sub.metadata?.user_id,
          customerId:     sub.customer,
        });
        await upsertSubscription(userId, {
          status:                 'canceled',
          stripe_subscription_id: sub.id,
        });
        break;
      }

      default:
        console.log('[webhook] event non géré :', event.type);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error', err);
    return res.status(500).json({ error: err.message });
  }
}
