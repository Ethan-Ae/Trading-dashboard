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

// ⚠️ Protection « compte gratuit à vie » (accordé manuellement) : si trial_ends_at
// est dans un futur lointain (après 2090), on ignore TOUT event Stripe pour ce
// user — aucun paiement/abonnement Stripe ne doit modifier son statut.
function isLifetimeFree(existingRow) {
  return !!(existingRow?.trial_ends_at && new Date(existingRow.trial_ends_at) > new Date('2090-01-01T00:00:00Z'));
}

// Reconcilie la ligne `subscriptions` avec la VRAIE liste des abonnements Stripe
// du client, plutôt que de faire confiance aveuglément à un seul event. Utilisé
// par customer.subscription.updated ET .deleted : s'il existe un abonnement actif
// ou en essai chez Stripe (ex. le nouvel annuel), c'est lui qui prévaut — même si
// l'event reçu concerne un autre abonnement (ex. l'ancien mensuel supprimé).
async function reconcileSubscriptionState({ userId, customerId, eventSubId, eventStatus, isDeleteEvent }) {
  if (!userId) {
    console.error('[webhook] userId manquant — reconciliation annulée');
    return;
  }

  const { data: existing } = await supabaseAdmin
    .from('subscriptions')
    .select('trial_ends_at, stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (isLifetimeFree(existing)) {
    console.log('[webhook] compte gratuit à vie (trial_ends_at', existing.trial_ends_at, ') — event ignoré pour', userId);
    return;
  }

  const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  const active = list.data.find(s => s.status === 'active' || s.status === 'trialing');

  if (active) {
    await upsertSubscription(userId, {
      status:                 active.status,
      stripe_customer_id:     customerId,
      stripe_subscription_id: active.id,
    });
    return;
  }

  // Aucun abonnement actif chez Stripe. On ne met à jour que si l'event concerne
  // bien l'abonnement actuellement enregistré, pour ignorer les events tardifs/
  // orphelins d'un abonnement déjà remplacé.
  if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== eventSubId) {
    console.log('[webhook] ignoré : event sub', eventSubId, '≠ sub enregistrée', existing.stripe_subscription_id, 'pour', userId);
    return;
  }

  await upsertSubscription(userId, {
    status:                 isDeleteEvent ? 'canceled' : eventStatus,
    stripe_customer_id:     customerId,
    stripe_subscription_id: eventSubId,
  });
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

        if (userId) {
          const { data: existing } = await supabaseAdmin
            .from('subscriptions')
            .select('trial_ends_at')
            .eq('user_id', userId)
            .maybeSingle();
          if (isLifetimeFree(existing)) {
            console.log('[webhook] compte gratuit à vie (trial_ends_at', existing.trial_ends_at, ') — checkout.session.completed ignoré pour', userId);
            break;
          }
        }

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

        // Sécurité anti-doublon : si le client a d'autres abonnements Stripe encore
        // actifs (ex. ancien mensuel pas résilié), on les annule — en excluant
        // explicitement celui qu'on vient tout juste de créer.
        if (session.customer && session.subscription) {
          const list = await stripe.subscriptions.list({ customer: session.customer, status: 'all', limit: 100 });
          const duplicates = list.data.filter(s =>
            s.id !== session.subscription && ['active', 'trialing', 'past_due'].includes(s.status)
          );
          for (const dup of duplicates) {
            try {
              await stripe.subscriptions.cancel(dup.id);
              console.log('[webhook] doublon annulé automatiquement :', dup.id, '(nouveau :', session.subscription, ') pour customer', session.customer);
            } catch (cancelErr) {
              console.error('[webhook] échec annulation doublon', dup.id, cancelErr.message);
            }
          }
        }
        break;
      }

      // ─── 2) Subscription modifiée (upgrade, downgrade, paiement renouvelé…) ───
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = await resolveUserId({
          metadataUserId: sub.metadata?.user_id,
          customerId:     sub.customer,
        });
        await reconcileSubscriptionState({
          userId,
          customerId:  sub.customer,
          eventSubId:  sub.id,
          eventStatus: sub.status,
          isDeleteEvent: false,
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
        await reconcileSubscriptionState({
          userId,
          customerId:  sub.customer,
          eventSubId:  sub.id,
          eventStatus: 'canceled',
          isDeleteEvent: true,
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
