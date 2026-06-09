// ════════════════════════════════════════════════════════════════
//  POST /api/create-checkout
//  Body : { priceId: string, accessToken: string }
//  Renvoie : { url: string }  ← URL Stripe Checkout
//
//  Sécurité : on vérifie le JWT Supabase côté serveur avec la
//  service_role key avant de faire quoi que ce soit. On ne fait
//  JAMAIS confiance à un user_id envoyé par le client.
// ════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Client admin Supabase — bypasse la RLS via la service_role key
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const SITE_URL = 'https://onertrade.ch';

export default async function handler(req, res) {
  // ─── CORS (utile si tu testes depuis un autre domaine) ───
  res.setHeader('Access-Control-Allow-Origin', SITE_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { priceId, accessToken } = req.body || {};
    if (!priceId)    return res.status(400).json({ error: 'priceId requis' });
    if (!accessToken) return res.status(401).json({ error: 'accessToken requis' });

    // ─── 1) Vérifier le token Supabase et récupérer le VRAI user ───
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(accessToken);
    if (authError || !user) {
      return res.status(401).json({ error: 'Token invalide', details: authError?.message });
    }

    // ─── 2) Récupérer (ou créer) le customer Stripe pour ce user ───
    const { data: subRow, error: subErr } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (subErr) {
      console.error('[create-checkout] subscriptions lookup error', subErr);
      return res.status(500).json({ error: 'DB lookup failed' });
    }

    let customerId = subRow?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id }
      });
      customerId = customer.id;

      // Sauvegarder côté DB (service_role bypasse la RLS)
      await supabaseAdmin
        .from('subscriptions')
        .update({ stripe_customer_id: customerId })
        .eq('user_id', user.id);
    }

    // ─── 3) Créer la session Checkout ───
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],

      // Deux endroits où on stocke user_id, pour fiabilité côté webhook
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      subscription_data: {
        metadata: { user_id: user.id }
      },

      success_url: `${SITE_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${SITE_URL}/?checkout=cancel`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[create-checkout] error', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
