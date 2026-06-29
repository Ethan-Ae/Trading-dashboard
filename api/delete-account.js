// ════════════════════════════════════════════════════════════════
//  POST /api/delete-account
//  Body : { accessToken: string }
//  Renvoie : { ok: true }
//
//  Supprime DÉFINITIVEMENT le compte de l'utilisateur :
//   1) Vérifie le JWT Supabase côté serveur (service_role) — on ne
//      fait JAMAIS confiance à un user_id envoyé par le client.
//   2) Annule l'abonnement Stripe + supprime le customer (best-effort).
//   3) Efface les données applicatives (trades, user_preferences,
//      subscriptions) via la service_role key (bypasse la RLS).
//   4) Supprime le compte Auth Supabase (admin.deleteUser).
//
//  Action irréversible, déclenchée par l'utilisateur lui-même depuis
//  la « Zone dangereuse » des réglages (double confirmation côté client).
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
  res.setHeader('Access-Control-Allow-Origin', SITE_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { accessToken } = req.body || {};
    if (!accessToken) return res.status(401).json({ error: 'accessToken requis' });

    // ─── 1) Vérifier le token et récupérer le VRAI user ───
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(accessToken);
    if (authError || !user) {
      return res.status(401).json({ error: 'Token invalide', details: authError?.message });
    }
    const userId = user.id;

    // ─── 2) Annuler l'abonnement Stripe (best-effort, ne bloque pas la suppression) ───
    try {
      const { data: subRow } = await supabaseAdmin
        .from('subscriptions')
        .select('stripe_subscription_id, stripe_customer_id')
        .eq('user_id', userId)
        .maybeSingle();

      if (subRow?.stripe_subscription_id) {
        await stripe.subscriptions.cancel(subRow.stripe_subscription_id)
          .catch(e => console.error('[delete-account] cancel subscription', e.message));
      }
      if (subRow?.stripe_customer_id) {
        await stripe.customers.del(subRow.stripe_customer_id)
          .catch(e => console.error('[delete-account] delete customer', e.message));
      }
    } catch (e) {
      console.error('[delete-account] stripe cleanup failed', e.message);
    }

    // ─── 3) Effacer les données applicatives ───
    for (const table of ['trades', 'user_preferences', 'subscriptions']) {
      const { error } = await supabaseAdmin.from(table).delete().eq('user_id', userId);
      if (error) console.error(`[delete-account] delete ${table} failed`, error.message);
    }

    // ─── 4) Supprimer le compte Auth ───
    const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (delErr) {
      console.error('[delete-account] auth deleteUser failed', delErr);
      return res.status(500).json({ error: 'Suppression du compte échouée', details: delErr.message });
    }

    console.log('[delete-account] compte supprimé :', userId);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[delete-account] error', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
