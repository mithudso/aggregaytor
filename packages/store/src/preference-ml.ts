/**
 * preference-ml.ts — Machine learning for profile preference prediction.
 *
 * Uses a lightweight logistic regression model that learns from user feedback
 * (like/dislike actions on profiles). Features are extracted from profile data,
 * photos, and conversation patterns.
 *
 * The model runs entirely client-side — no external ML service needed.
 */

import type { PreferenceFeedbackDoc, PreferenceModelDoc, ProfileFeatures } from './types.js';
import type { Platform } from '@aggregaytor/adapter-core';
import { getDB } from './db.js';
import type { StoreDatabase } from './db.js';

const MODEL_ID = 'prefmodel:latest';

// ── Feature extraction ──────────────────────────────────────────────────────

/**
 * Extract numerical features from a profile for ML scoring.
 * Returns a flat object with consistent feature names.
 */
export function extractFeatures(raw: Partial<ProfileFeatures>): Record<string, number> {
  const features: Record<string, number> = {};

  // Body type one-hot encoding
  const bodyTypes = ['slim', 'athletic', 'average', 'muscular', 'chubby', 'stocky', 'toned'];
  const bt = (raw.bodyType || '').toLowerCase();
  for (const t of bodyTypes) features[`body_${t}`] = bt.includes(t) ? 1 : 0;

  // Position one-hot
  const positions = ['top', 'bottom', 'vers', 'side'];
  const pos = (raw.position || '').toLowerCase();
  for (const p of positions) features[`pos_${p}`] = pos.includes(p) ? 1 : 0;

  // Numeric features (normalized)
  features.profile_text_length = Math.min((raw.profileTextLength || 0) / 500, 1);
  features.has_photo = raw.hasPhoto ? 1 : 0;
  features.photo_count = Math.min((raw.photoCount || 0) / 10, 1);
  features.conversation_length = Math.min((raw.conversationLength || 0) / 50, 1);
  features.response_rate = raw.responseRate || 0;

  // Profile text keyword signals
  const keywords = raw.profileTextKeywords || [];
  const positiveKeywords = ['fun', 'discreet', 'chill', 'masc', 'fit', 'clean', 'safe', 'host', 'mobile'];
  const negativeKeywords = ['drama', 'pic4pic', 'no blacks', 'no asians', 'no fats', 'no fems'];
  features.positive_keyword_count = Math.min(keywords.filter(k => positiveKeywords.some(pk => k.toLowerCase().includes(pk))).length / 5, 1);
  features.negative_keyword_count = Math.min(keywords.filter(k => negativeKeywords.some(nk => k.toLowerCase().includes(nk))).length / 3, 1);

  return features;
}

// ── Logistic regression model ───────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function predict(features: Record<string, number>, weights: Record<string, number>): number {
  let sum = weights._bias || 0;
  for (const [key, value] of Object.entries(features)) {
    sum += (weights[key] || 0) * value;
  }
  return sigmoid(sum);
}

/** Unbiased Fisher-Yates shuffle, returning a new array. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Train the model incrementally with a single new data point.
 * Uses online stochastic gradient descent.
 */
function trainStep(
  weights: Record<string, number>,
  features: Record<string, number>,
  liked: boolean,
  learningRate = 0.1,
): Record<string, number> {
  const updated = { ...weights };
  const prediction = predict(features, updated);
  const target = liked ? 1 : 0;
  const error = target - prediction;
  const gradient = error * prediction * (1 - prediction);

  updated._bias = (updated._bias || 0) + learningRate * gradient;
  for (const [key, value] of Object.entries(features)) {
    updated[key] = (updated[key] || 0) + learningRate * gradient * value;
  }
  return updated;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function recordFeedback(
  contactId: string,
  platform: Platform,
  liked: boolean,
  features: ProfileFeatures,
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();
  const now = Date.now();
  const doc: PreferenceFeedbackDoc = {
    _id: `pref:${contactId}:${now}`,
    docType: 'preference_feedback',
    contactId,
    platform,
    liked,
    features,
    createdAt: new Date(now).toISOString(),
  };
  await store.put(doc);

  // Incrementally update the model
  await updateModel(features, liked, store);
}

async function updateModel(
  rawFeatures: ProfileFeatures,
  liked: boolean,
  store: StoreDatabase,
): Promise<void> {
  let model: PreferenceModelDoc;
  try {
    model = await store.get(MODEL_ID) as PreferenceModelDoc;
  } catch (err: any) {
    // ONLY a genuine "no model yet" starts from scratch. Swallowing every
    // error here meant a transient read failure re-initialised the weights and
    // the following put() overwrote every trained weight with a blank model.
    if (err?.status !== 404) throw err;
    model = {
      _id: MODEL_ID,
      docType: 'preference_model',
      featureWeights: { _bias: 0 },
      trainingCount: 0,
      accuracy: 0.5,
      lastTrainedAt: '',
      version: 1,
    };
  }

  const features = extractFeatures(rawFeatures);
  model.featureWeights = trainStep(model.featureWeights, features, liked);
  model.trainingCount += 1;
  model.lastTrainedAt = new Date().toISOString();

  // Estimate accuracy using running average of correct predictions
  const prediction = predict(features, model.featureWeights);
  const correct = (liked && prediction > 0.5) || (!liked && prediction <= 0.5);
  const alpha = Math.min(0.1, 1 / model.trainingCount); // smoothing factor
  model.accuracy = model.accuracy * (1 - alpha) + (correct ? 1 : 0) * alpha;

  await store.put(model);
}

export async function predictPreference(
  rawFeatures: ProfileFeatures,
  db?: StoreDatabase,
): Promise<{ score: number; confidence: number }> {
  const store = db || await getDB();
  try {
    const model = await store.get(MODEL_ID) as PreferenceModelDoc;
    const features = extractFeatures(rawFeatures);
    const score = predict(features, model.featureWeights);
    const confidence = Math.min(model.trainingCount / 50, 1); // confidence grows with data
    return { score, confidence };
  } catch (err: any) {
    // A missing model is normal; anything else is worth a breadcrumb before
    // we fall back to the neutral prediction.
    if (err?.status !== 404) console.warn('[PreferenceML] predict failed:', err);
    return { score: 0.5, confidence: 0 };
  }
}

export async function getModelStats(db?: StoreDatabase): Promise<{
  trainingCount: number;
  accuracy: number;
  topFeatures: Array<{ feature: string; weight: number }>;
}> {
  const store = db || await getDB();
  try {
    const model = await store.get(MODEL_ID) as PreferenceModelDoc;
    const topFeatures = Object.entries(model.featureWeights)
      .filter(([k]) => k !== '_bias')
      .map(([feature, weight]) => ({ feature, weight }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 10);
    return { trainingCount: model.trainingCount, accuracy: model.accuracy, topFeatures };
  } catch (err: any) {
    if (err?.status !== 404) console.warn('[PreferenceML] model stats unavailable:', err);
    return { trainingCount: 0, accuracy: 0.5, topFeatures: [] };
  }
}

export async function getAllFeedback(db?: StoreDatabase): Promise<PreferenceFeedbackDoc[]> {
  const store = db || await getDB();
  const result = await store.find({ selector: { docType: 'preference_feedback' } });
  return result.docs as PreferenceFeedbackDoc[];
}

/**
 * Retrain the model from scratch using all feedback data.
 * Call periodically for more accurate weights.
 */
export async function retrainModel(db?: StoreDatabase): Promise<void> {
  const store = db || await getDB();
  const feedback = await getAllFeedback(store);
  if (!feedback.length) return;

  let weights: Record<string, number> = { _bias: 0 };

  // Multiple passes for convergence
  for (let epoch = 0; epoch < 5; epoch++) {
    // Shuffle for each epoch. `sort(() => Math.random() - 0.5)` is NOT a
    // shuffle — comparator-based "shuffles" are strongly biased toward the
    // original order (and are implementation-defined), which defeats the
    // point of shuffling between SGD epochs.
    const shuffled = shuffle(feedback);
    for (const entry of shuffled) {
      const features = extractFeatures(entry.features);
      weights = trainStep(weights, features, entry.liked, 0.05);
    }
  }

  // Calculate accuracy
  let correct = 0;
  for (const entry of feedback) {
    const features = extractFeatures(entry.features);
    const pred = predict(features, weights);
    if ((entry.liked && pred > 0.5) || (!entry.liked && pred <= 0.5)) correct++;
  }

  const model: PreferenceModelDoc = {
    _id: MODEL_ID,
    docType: 'preference_model',
    featureWeights: weights,
    trainingCount: feedback.length,
    accuracy: correct / feedback.length,
    lastTrainedAt: new Date().toISOString(),
    version: 1,
  };

  try {
    const existing = await store.get(MODEL_ID);
    model._rev = existing._rev;
  } catch { /* new model */ }

  await store.put(model);
}
