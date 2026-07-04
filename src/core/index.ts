/**
 * Core Layer - Vigil Robotics Core Systems
 */

export {
  checkForUpdates,
  maybeAutoUpdate,
  formatUpdateNotification,
  formatUpdateBanner,
  getUpdateDecision,
  shouldShowUpdateNotification,
  readAutoUpdateState,
  performBackgroundUpdate,
  performUpdate,
  updateAndContinue,
  installPackageVersion,
  runNpmInstall,
  saveSessionState,
  loadSessionState,
  clearSessionState,
  hasPendingSession,
  type UpdateInfo,
  type AutoUpdateResult,
  type AutoUpdateState,
  type SessionState,
} from './updateChecker.js';

export {
  loadModelPreference,
  saveModelPreference,
  loadSessionPreferences,
  saveSessionPreferences,
  loadFeatureFlags,
  saveFeatureFlags,
  type SessionPreferences,
  type FeatureFlags,
} from './preferences.js';

export {
  InputProtection,
  initializeInputProtection,
  getInputProtection,
  validateChatInput,
  validatePromptSubmit,
  type InputValidation,
  type InputAnomalyType,
  type InputProtectionConfig,
} from './inputProtection.js';
