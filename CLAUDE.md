# OneRtrade — Consignes pour Claude

## ⚠️ RÈGLE ABSOLUE — NE JAMAIS SUPPRIMER LES DONNÉES DES UTILISATEURS

Quand on me demande de **modifier** quoi que ce soit, je ne dois **JAMAIS** supprimer,
écraser ou altérer les données des utilisateurs (tables Supabase `trades`,
`user_preferences`, `subscriptions`, ou les comptes Auth).

- Aucune modification de code ne doit déclencher d'effacement de données utilisateur.
- Pour l'i18n : les **valeurs stockées en base restent en français** (matching /
  persistance) ; on traduit uniquement l'**affichage** (`tVal()` / `L()`).
- Les seules suppressions autorisées sont celles **explicitement déclenchées par
  l'utilisateur lui-même** depuis l'UI (ex. « Tout supprimer », « Supprimer mon
  compte ») — jamais comme effet de bord d'une autre modification.
- En cas de doute sur l'impact d'un changement sur les données : **demander avant**.

## Contexte du projet

- App = **un seul fichier** `index.html` (gros `<script>` inline). Plus endpoints
  serverless dans `api/` (`create-checkout.js`, `stripe-webhook.js`, `delete-account.js`).
- État JS : `let` à portée module (PAS sur `window`) ; les `function` hoistées sont
  appelables depuis les `onclick` inline.
- **Supabase** (auth + données) · **Stripe** (paiements) · déployé sur **Vercel**
  (`onertrade.ch` / `www.onertrade.ch`).
- ⚠️ **OneDrive** : le repo est synchronisé entre deux Macs → risque de perte.
  Vérifier l'intégrité (`wc -l index.html`, marqueurs `renderQuarterly`/`lp-hero`/
  `RESULT_OPTIONS`) puis **commit + push rapidement** après chaque travail.
- **Node n'est pas installé** localement → valider via la preview (serveur statique
  Python, port 5173), pas via npm/node.

## i18n & devise

- Bilingue FR/EN : `STRINGS={fr,en}`, `t(key)`, `applyTranslations()`, `setLang()`,
  helpers `L(fr,en)` et `tVal(valeurStockéeFR)`.
- **Site public (non connecté) = toujours anglais** (`currentLang='en'` au démarrage,
  on ne lit PAS le localStorage). Le français vient **uniquement** de la préférence
  du compte après connexion (`loadUserPreferences` → `setLang`).
- **Devise liée à la langue** : FR → EUR, EN → USD (`currencyForLang`). Pas de choix
  de devise indépendant. Les clients français restent en EUR.
