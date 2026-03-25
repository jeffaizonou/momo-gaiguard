require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

/* Ajout de base de donnees SQLite et de CSV comme backup (secours alternatif)*/
const fs   = require('fs');
const path = require('path');

// ── Système de log CSV pour la recherche ──────────────────────────
const LOG_FILE = path.join(__dirname, 'logs.csv');

// Crée le fichier avec les en-têtes s'il n'existe pas encore
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(
    LOG_FILE,
    'date,heure,departement,score,risque,nb_signaux,signaux,longueur_message,mode_analyse\n',
    'utf8'
  );
  console.log('📊 Fichier logs.csv créé');
}

function enregistrerLog(expediteur, score, risque, alertes, longueurMsg, modeAnalyse) {
  const maintenant  = new Date();
  const date        = maintenant.toLocaleDateString('fr-FR');
  const heure       = maintenant.toLocaleTimeString('fr-FR');
  const signaux     = alertes.join(' · ').replace(/,/g, ';'); // évite les conflits CSV
  const nbSignaux   = alertes.length;

  const ligne = `"${date}","${heure}","${nbSignaux}","${score}","${risque}","${nbSignaux}","${signaux}","${longueurMsg}","${modeAnalyse}"\n`;

  fs.appendFileSync(LOG_FILE, ligne, 'utf8');
}/* Fin ajout sauvegarde de donnees*/

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Claude API (activé seulement si clé présente) ──────────────────
const claude = process.env.ANTHROPIC_API_KEY !== 'votre_cle_ici'
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ── Détection locale (fonctionne SANS internet ni clé API) ─────────

function detectionRapide(message) {
  const signaux = [
    
    // ── CODES & MOTS DE PASSE ─────────────────────────────────────
    { test: /code pin|pin|mot de passe|password|code secret/i,
      score: 40, texte: '🔑 Demande de code PIN ou mot de passe' },

    { test: /otp|code de confirmation|code reçu|code envoyé|code sms/i,
      score: 38, texte: '🔢 Demande de code OTP' },

    { test: /donnez.*(code|pin|otp)|envoyer.*(code|pin|otp)|communiquer.*(code|pin)/i,
      score: 42, texte: '🔑 Instruction de partager un code' },

    // ── FAUX GAINS & TIRAGES ──────────────────────────────────────
    { test: /gagné|gagnant|tirage|prize|félicitations|vous avez été sélectionné/i,
      score: 32, texte: '🏆 Faux gain ou tirage annoncé' },

    { test: /lot|loterie|tombola|jackpot/i,
      score: 28, texte: '🎰 Loterie ou tombola suspecte' },

    { test: /fcfa|franc.*gagné|million.*gagné|500.000|200.000|100.000/i,
      score: 20, texte: '💰 Montant important mentionné' },

    // ── FAUX AGENTS & OPÉRATEURS ──────────────────────────────────
    { test: /agent mtn|agent moov|agent celtiis|technicien mtn|technicien moov/i,
      score: 30, texte: '👮 Prétend être un agent opérateur' },

    { test: /service client mtn|service client moov|support mtn|support moov/i,
      score: 28, texte: '📞 Prétend être le service client' },

    { test: /mise à jour.*compte|vérification.*compte|bloquer.*compte|suspendre.*compte/i,
      score: 32, texte: '🔒 Menace de blocage de compte' },

    { test: /vérifier votre identité|confirmer votre numéro|valider votre sim/i,
      score: 30, texte: '🪪 Demande de vérification d\'identité' },

    // ── URGENCES FAMILIALES ───────────────────────────────────────
    { test: /accident|hôpital|urgence médicale|blessé|opération/i,
      score: 22, texte: '🚑 Urgence médicale suspecte' },

    { test: /c\'est moi|c est moi|numéro d\'un ami|téléphone cassé|nouveau numéro/i,
      score: 25, texte: '👤 Usurpation d\'identité probable' },

    { test: /papa|maman|fiston|ma fille|mon fils|tonton|tata/i,
      score: 12, texte: '👨‍👩‍👧 Appel à lien familial' },

    // ── FAUX REMBOURSEMENTS ───────────────────────────────────────
    { test: /envoyé par erreur|transfert.*erreur|erreur.*transfert|rembours/i,
      score: 28, texte: '🔁 Schéma de faux remboursement' },

    { test: /reçu.*transfert|preuve.*paiement|capture.*écran|screenshot/i,
      score: 15, texte: '🧾 Reçu potentiellement falsifié' },

    // ── INVESTISSEMENTS MIRACLES ──────────────────────────────────
    { test: /doubl|tripl|multiplier|x2|x3|rendement garanti/i,
      score: 38, texte: '💸 Promesse de multiplication d\'argent' },

    { test: /investiss|placement|bénéfice garanti|profit assuré/i,
      score: 30, texte: '📈 Investissement miracle suspect' },

    { test: /groupe.*whatsapp|rejoindre.*groupe|membres.*satisfaits/i,
      score: 22, texte: '👥 Schéma pyramidal WhatsApp' },

    { test: /48h|24h|72h|en.*heures.*récupérer/i,
      score: 18, texte: '⚡ Promesse de gain rapide' },

    // ── FRAIS SUSPECTS ────────────────────────────────────────────
    { test: /frais de déblocage|frais d\'activation|frais.*recevoir|payer.*récupérer/i,
      score: 38, texte: '🔓 Frais de déblocage frauduleux' },

    { test: /avance|caution|dépôt.*garantie|frais.*dossier/i,
      score: 28, texte: '💳 Paiement préalable suspect' },

    // ── PRESSION & MANIPULATION ───────────────────────────────────
    { test: /urgent|vite|rapidement|immédiatement|ne tardez pas/i,
      score: 15, texte: '⏰ Pression temporelle' },

    { test: /2 heures|1 heure|30 minutes|avant minuit|aujourd\'hui seulement/i,
      score: 20, texte: '⏳ Délai artificiel pour stresser' },

    { test: /dernière chance|offre limitée|places limitées|expire/i,
      score: 18, texte: '🎯 Fausse urgence de disponibilité' },

    { test: /dieu vous bénisse|que dieu|au nom de dieu|inch allah/i,
      score: 10, texte: '🙏 Manipulation religieuse' },

    { test: /discret|entre nous|ne dites pas|gardez le secret|confidenti/i,
      score: 25, texte: '🤫 Demande de secret suspect' },

    // ── NUMÉROS & REDIRECTION ─────────────────────────────────────
    { test: /appelez ce numéro|contactez le|envoyez sur ce|nouveau numéro/i,
      score: 20, texte: '📲 Redirection vers numéro inconnu' },

    { test: /\+229\s*0[0-9]|\+229\s*5[0-9]|\+229\s*6[0-9]/i,
      score: 8,  texte: '📱 Numéro béninois mentionné' },

    // ── ROMANCE SCAM ──────────────────────────────────────────────
    { test: /colis.*bloqué|douane.*colis|cadeau.*bloqué|billet.*avion/i,
      score: 35, texte: '📦 Arnaque colis/douane' },

    { test: /je t\'aime|mon amour|ma chérie|mon chéri/i,
      score: 8,  texte: '❤️ Approche sentimentale' },

  ];
/* Ancien
    { test: /code pin|pin|mot de passe|password|code secret|/i, score: 40, texte: '🔑 Demande de code PIN ou mot de passe' },
    { test: /otp|code de confirmation|code reçu|code envoyé|code sms/i,   score: 38, texte: '🔢 Demande de code OTP' },
    { test: /gagné|gagnant|tirage|prize|félicitations/i, score: 30, texte: '🏆 Faux gain annoncé' },
    { test: /agent mtn|agent moov|service client/i,  score: 25, texte: '👮 Faux agent opérateur' },
    { test: /envoy.*erreur|erreur.*envoy/i,          score: 25, texte: '🔁 Faux remboursement' },
    { test: /accident|hôpital|urgence médicale/i,    score: 20, texte: '🚑 Urgence familiale suspecte' },
    { test: /doubl|multiplier|investiss|bénéfice garanti/i, score: 35, texte: '💸 Investissement miracle' },
    { test: /urgent|vite|2 heures|24h|maintenant/i,  score: 15, texte: '⏰ Pression temporelle' },
    { test: /débloquer|frais de déblocage|frais/i,   score: 30, texte: '🔓 Frais de déblocage' },
    { test: /numéro.*gagnant|vous êtes sélectionné/i, score: 30, texte: '🎯 Sélection suspecte' },
  ];*/

  let score = 0;
  let alertes = [];

  for (const signal of signaux) {
    if (signal.test.test(message)) {
      score += signal.score;
      alertes.push(signal.texte);
    }
  }

  return { score: Math.min(score, 100), alertes };
}

// ── Analyse par Claude (si clé API disponible) ─────────────────────
async function analyserAvecClaude(message) {
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Tu es MoMoGuard, expert en arnaques Mobile Money au Bénin (MTN, Moov, Celtiis).

Analyse ce message et réponds UNIQUEMENT en JSON valide :
{
  "risque": "DANGER" ou "SUSPECT" ou "SUR",
  "score": (nombre de 0 à 100),
  "verdict": "phrase courte max 8 mots",
  "conseil": "action concrète en 1 phrase simple"
}

Message : "${message}"

JSON uniquement, rien d'autre.`
    }]
  });

  const texte = response.content[0].text.trim();
  return JSON.parse(texte.replace(/```json|```/g, '').trim());
}

// ── Construire la réponse finale ───────────────────────────────────
function construireReponse(analyse, alertes) {
  const emojis  = { DANGER: '🚨', SUSPECT: '⚠️', SUR: '✅' };
  const niveaux = { DANGER: 'ARNAQUE PROBABLE', SUSPECT: 'MESSAGE SUSPECT', SUR: 'MESSAGE NORMAL' };

  let rep = `${emojis[analyse.risque]} *${niveaux[analyse.risque]}*\n`;
  rep += `━━━━━━━━━━━━━━━━━━━━\n`;
  rep += `📊 *Score de risque :* ${analyse.score}/100\n`;
  rep += `📋 *Analyse :* ${analyse.verdict}\n\n`;

  if (alertes.length > 0) {
    rep += `*Signaux détectés :*\n`;
    alertes.forEach(a => { rep += `  ${a}\n`; });
    rep += '\n';
  }

  rep += `💡 *À faire maintenant :*\n${analyse.conseil}\n\n`;
  rep += `━━━━━━━━━━━━━━━━━━━━\n`;
  rep += `_MoMoGuard · Recherche UCAO Bénin_\n`;
  rep += `_MTN: 100 · Moov: 144 · Police: 166_`;

  return rep;
}

// ── Message d'accueil ──────────────────────────────────────────────
function accueil() {
  return `👋 *Bienvenue sur MoMoGuard !*
━━━━━━━━━━━━━━━━━━━━
🛡️ Je protège contre les arnaques Mobile Money au Bénin.

*Comment utiliser :*
Copiez-collez le message suspect que vous avez reçu et envoyez-le moi. Je l'analyse en quelques secondes.

*Je détecte :*
• Faux tirages MTN / Moov
• Faux agents opérateurs  
• Urgences familiales frauduleuses
• Demandes de code PIN / OTP
• Faux remboursements

Envoyez votre message suspect maintenant ⬇️

_Service gratuit · Projet de recherche académique_`;
}

//debut interface web
// ── Servir l'interface web ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Route API pour l'interface web ────────────────────────────────
app.post('/analyser', async (req, res) => {
  const message = (req.body.message || '').trim();
  if (!message) {
    return res.json({ risque: 'SUR', score: 0, verdict: 'Message vide', conseil: '', alertes: [] });
  }

  const { score: scoreLocal, alertes } = detectionRapide(message);

  let analyse;
  try {
    if (claude && scoreLocal < 70) {
      analyse = await analyserAvecClaude(message);
    } else if (scoreLocal >= 70) {
      analyse = {
        risque:  'DANGER',
        score:   scoreLocal,
        verdict: 'Arnaque Mobile Money détectée',
        conseil: 'Ne répondez pas. Bloquez ce numéro. Appelez le 100 (MTN) ou 144 (Moov).'
      };
    } else {
      analyse = {
        risque:  scoreLocal >= 40 ? 'SUSPECT' : 'SUR',
        score:   scoreLocal,
        verdict: scoreLocal >= 40 ? 'Message potentiellement suspect' : 'Aucun signal évident',
        conseil: 'En cas de doute, appelez le 100 (MTN) ou 144 (Moov).'
      };
    }
  } catch (e) {
    analyse = {
      risque:  scoreLocal >= 50 ? 'DANGER' : 'SUSPECT',
      score:   scoreLocal,
      verdict: 'Analyse locale effectuée',
      conseil: 'En cas de doute, appelez le 100 (MTN) ou 144 (Moov).'
    };
  }

  // Log
  enregistrerLog('web', analyse.score, analyse.risque, alertes, message.length, 'web');

  res.json({ ...analyse, alertes });
});// fin interface web

// ── Webhook principal : reçoit les messages WhatsApp ──────────────
app.post('/webhook', async (req, res) => {
  const message  = (req.body.Body || '').trim();
  const expediteur = req.body.From || 'inconnu';

  // Log pour la recherche (anonymisé)
  console.log(`[${new Date().toISOString()}] De: ${expediteur} | Message: ${message.substring(0, 80)}...`);

  // Commandes spéciales
  const commandes = ['bonjour', 'aide', 'help', 'hello', 'salut', 'start'];
  if (!message || commandes.includes(message.toLowerCase())) {
    res.set('Content-Type', 'text/xml');
    return res.send(
      `<?xml version="1.0" encoding="UTF-8"?>
       <Response><Message>${accueil()}</Message></Response>`
    );
  }

  // Détection locale (toujours faite)
  const { score: scoreLocal, alertes } = detectionRapide(message);

  let analyse;

  try {
    if (claude && scoreLocal < 70) {
      // Claude analyse les cas ambigus
      analyse = await analyserAvecClaude(message);
    } else if (scoreLocal >= 70) {
      // Score local très élevé = on n'a pas besoin de Claude
      analyse = {
        risque:  'DANGER',
        score:   scoreLocal,
        verdict: 'Arnaque Mobile Money détectée',
        conseil: 'Ne répondez pas. Bloquez ce numéro. Appelez le 100 (MTN) ou 144 (Moov).'
      };
    } else {
      // Pas de clé Claude + score bas = détection locale seule
      analyse = {
        risque:  scoreLocal >= 40 ? 'SUSPECT' : 'SUR',
        score:   scoreLocal,
        verdict: scoreLocal >= 40 ? 'Message potentiellement suspect' : 'Aucun signal évident détecté',
        conseil: 'En cas de doute, appelez directement le 100 (MTN) ou 144 (Moov).'
      };
    }
  } catch (erreur) {
    console.error('Erreur API Claude:', erreur.message);
    // Fallback propre si Claude échoue
    analyse = {
      risque:  scoreLocal >= 50 ? 'DANGER' : scoreLocal >= 20 ? 'SUSPECT' : 'SUR',
      score:   scoreLocal,
      verdict: 'Analyse de base effectuée',
      conseil: 'En cas de doute, ne donnez rien et appelez le 100 (MTN) ou 144 (Moov).'
    };
  }

  // ── Enregistrement pour la recherche ────────────────────────────
  const modeAnalyse = claude && scoreLocal < 70 ? 'claude' : 'local';
  enregistrerLog(
    expediteur,
    analyse.score,
    analyse.risque,
    alertes,
    message,
    message.length,
    modeAnalyse
  );

  const reponse = construireReponse(analyse, alertes);

  res.set('Content-Type', 'text/xml');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>
     <Response><Message>${reponse}</Message></Response>`
  );
});

// ── Route de statut (vérifier que le bot tourne) ──────────────────
/* Ceci se charge quand on lance "localhost:3001" dans le navigateur 
apres avoir execute "node index.js dans le terminal" */
app.get('/', (req, res) => {
  const statut = claude ? '✅ IA Claude active' : '⚙️ Mode local uniquement';
  res.send(`
    <h2>🛡️ MoMo GaïGuard — Actif</h2>
    <p>Statut : ${statut}</p>
    <p>Heure : ${new Date().toLocaleString('fr-FR')}</p>
    <p>Port : ${process.env.PORT}</p>
  `);
});

// ── Démarrage du serveur ──────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('');
  console.log('🛡️  MoMo GaïGuard démarré avec succès');
  console.log(`📡  Port        : ${PORT}`);
  console.log(`🤖  Claude IA   : ${claude ? 'Activée' : 'Désactivée (mode local)'}`);
  console.log(`🔗  URL locale  : http://localhost:${PORT}`);
  console.log('');
  console.log('En attente de messages...');
});